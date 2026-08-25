BEGIN;

-- Task 3:
-- Snapshot alt-text edits must target one exact media_assets row.
-- The previous RPC assumed at most one snapshot_image per project, which is no
-- longer valid once a project can contain an ordered multi-image gallery.

-- Remove the old 4-argument RPC so callers cannot accidentally continue using
-- the single-snapshot mutation path.
REVOKE ALL ON FUNCTION
  public.update_snapshot_image_alt_text(text, text, timestamptz, uuid)
FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS
  public.update_snapshot_image_alt_text(text, text, timestamptz, uuid);

CREATE FUNCTION public.update_snapshot_image_alt_text(
  p_public_id text,
  p_media_asset_id uuid,
  p_alt_text text,
  p_expected_updated_at timestamptz,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_alt_text text;
  v_roles text[];
  v_project_id uuid;
  v_status text;
  v_current_updated_at timestamptz;
  v_updated_at timestamptz;
  v_media_id uuid;
  v_old_alt_text text;
  v_actor_full_name text;
  v_actor_email text;
  v_event_details jsonb;
  v_audit_record_id uuid;
BEGIN
  -- -------------------------------------------------------------------------
  -- 1. Input validation
  -- -------------------------------------------------------------------------

  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_NOT_FOUND'
    );
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);

  IF
    v_public_id = ''
    OR pg_catalog.length(v_public_id) > 100
    OR v_public_id !~ '^[A-Za-z0-9_-]+$'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'VALIDATION_FAILED'
    );
  END IF;

  IF p_media_asset_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'SNAPSHOT_MEDIA_NOT_FOUND'
    );
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PERMISSION_DENIED'
    );
  END IF;

  -- Staff-authored content only. Trim, require non-empty text, and enforce
  -- the existing shared storage ceiling.
  v_alt_text :=
    pg_catalog.btrim(COALESCE(p_alt_text, ''));

  IF v_alt_text = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'VALIDATION_FAILED'
    );
  END IF;

  IF pg_catalog.length(v_alt_text) > 2000 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'ALT_TEXT_TOO_LONG'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 2. Authorization
  -- -------------------------------------------------------------------------

  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles AS r
   WHERE r.user_id = p_admin_id;

  IF
    v_roles IS NULL
    OR pg_catalog.cardinality(v_roles) = 0
    OR NOT (
      'admin' = ANY(v_roles)
      OR 'editor' = ANY(v_roles)
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PERMISSION_DENIED'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 3. Resolve and lock project
  -- -------------------------------------------------------------------------

  SELECT
    p.id,
    p.status,
    p.updated_at
  INTO
    v_project_id,
    v_status,
    v_current_updated_at
  FROM public.projects AS p
  WHERE p.public_id = v_public_id
    AND p.deleted_at IS NULL
  FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_NOT_FOUND'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 4. Workflow state
  -- -------------------------------------------------------------------------

  IF v_status = 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'APPROVAL_REOPEN_REQUIRED'
    );
  END IF;

  IF v_status = 'published' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PUBLISHED_PROJECT_LOCKED'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 5. Shared optimistic-concurrency boundary
  -- -------------------------------------------------------------------------

  IF
    v_current_updated_at
    IS DISTINCT FROM
    p_expected_updated_at
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'STALE_VERSION'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 6. Resolve the exact requested media row.
  --
  -- The browser may supply a media id as an identity selector, but it cannot
  -- decide whether that id is valid. The database independently proves:
  --
  --   media id exists
  --   AND belongs to this project
  --   AND is snapshot_image
  --
  -- A poster id, another project's snapshot id, or an unknown id therefore
  -- cannot be edited through this mutation.
  -- -------------------------------------------------------------------------

  SELECT
    ma.id,
    ma.alt_text_public
  INTO
    v_media_id,
    v_old_alt_text
  FROM public.media_assets AS ma
  WHERE ma.id = p_media_asset_id
    AND ma.project_id = v_project_id
    AND ma.asset_type = 'snapshot_image'
  FOR UPDATE;

  IF v_media_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'SNAPSHOT_MEDIA_NOT_FOUND'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 7. No-op save
  -- -------------------------------------------------------------------------

  IF v_old_alt_text IS NOT DISTINCT FROM v_alt_text THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'NO_CHANGES',
      'snapshotAltText', v_alt_text,
      'mediaAssetId', v_media_id::text,
      'expectedUpdatedAt', v_current_updated_at
    );
  END IF;

  SELECT
    u.full_name,
    u.email
  INTO
    v_actor_full_name,
    v_actor_email
  FROM public.admin_users AS u
  WHERE u.id = p_admin_id;

  ---------------------------------------------------------------------------
  -- ALL VALIDATION PASSED BEFORE MUTATIONS BEGIN.
  ---------------------------------------------------------------------------

  UPDATE public.media_assets
     SET alt_text_public = v_alt_text
   WHERE id = v_media_id;

  -- Keep snapshot edits on the shared project version line. This preserves the
  -- existing stale-view behavior and invalidates participant confirmation of
  -- the previous project/media state.
  UPDATE public.projects
     SET updated_at = pg_catalog.now()
   WHERE id = v_project_id
  RETURNING updated_at
       INTO v_updated_at;

  -- Preserve the existing media_accessibility audit contract. mediaAssetId now
  -- identifies the exact gallery image that changed.
  v_event_details :=
    pg_catalog.jsonb_build_object(
      'version', 1,
      'type', 'media_accessibility',
      'mediaAssetId', v_media_id::text,
      'assetType', 'snapshot_image',
      'changedFields',
        pg_catalog.to_jsonb(
          ARRAY['snapshotAltText']
        ),
      'before',
        pg_catalog.jsonb_build_object(
          'snapshotAltText',
          v_old_alt_text
        ),
      'after',
        pg_catalog.jsonb_build_object(
          'snapshotAltText',
          v_alt_text
        )
    );

  INSERT INTO public.approval_records(
    project_id,
    admin_id,
    action_taken,
    from_status,
    to_status,
    comments,
    actor_full_name_snapshot,
    actor_email_snapshot,
    event_details
  )
  VALUES (
    v_project_id,
    p_admin_id,
    'update_metadata',
    v_status,
    v_status,
    'Updated snapshot image alt text.',
    v_actor_full_name,
    v_actor_email,
    v_event_details
  )
  RETURNING id
       INTO v_audit_record_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'snapshotAltText', v_alt_text,
    'mediaAssetId', v_media_id::text,
    'expectedUpdatedAt', v_updated_at,
    'auditRecordId', v_audit_record_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.update_snapshot_image_alt_text(
    text,
    uuid,
    text,
    timestamptz,
    uuid
  )
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.update_snapshot_image_alt_text(
    text,
    uuid,
    text,
    timestamptz,
    uuid
  )
TO service_role;

COMMIT;