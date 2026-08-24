

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_participant_preview(
  p_public_id text,
  p_admin_id uuid,
  p_token_hash text,
  p_expires_in_seconds integer,
  p_private_bucket text,
  p_is_correction_reissue boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_private_bucket text;
  v_roles text[];
  v_project_id uuid;
  v_status text;
  v_existing_active_count integer;
  v_open_correction_count integer;
  v_in_progress_correction_id uuid;
  v_expires_in integer;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_preview_id uuid;
  v_snapshot jsonb;
  v_media_snapshot jsonb;
  v_has_edit boolean;
  v_has_review boolean;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. Input validation
  ---------------------------------------------------------------------------

  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_NOT_FOUND'
    );
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);

  IF v_public_id = ''
     OR pg_catalog.length(v_public_id) > 100
     OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_SELECTION'
    );
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PREVIEW_PERMISSION_DENIED'
    );
  END IF;

  IF p_token_hash IS NULL
     OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_TOKEN_HASH'
    );
  END IF;

  IF p_private_bucket IS NULL
     OR pg_catalog.btrim(p_private_bucket) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_PRIVATE_BUCKET'
    );
  END IF;

  v_private_bucket := pg_catalog.btrim(p_private_bucket);

  v_expires_in := COALESCE(
    p_expires_in_seconds,
    604800
  );

  IF v_expires_in < 3600
     OR v_expires_in > 2592000 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_EXPIRY'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 2. Serialize participant-preview operations for this project.
  ---------------------------------------------------------------------------

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      'participant_preview:' || v_public_id
    )
  );

  ---------------------------------------------------------------------------
  -- 3. Authorization
  ---------------------------------------------------------------------------

  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL
     OR pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PREVIEW_PERMISSION_DENIED'
    );
  END IF;

  v_has_edit := (
    'admin' = ANY(v_roles)
    OR 'editor' = ANY(v_roles)
  );

  v_has_review := (
    'admin' = ANY(v_roles)
    OR 'reviewer' = ANY(v_roles)
  );

  IF COALESCE(p_is_correction_reissue, false) THEN

    -- A correction reissue requires both edit and review authority.
    IF NOT (v_has_edit AND v_has_review) THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'PREVIEW_PERMISSION_DENIED'
      );
    END IF;

  ELSE

    -- Ordinary preview generation requires review authority.
    IF NOT v_has_review THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'PREVIEW_PERMISSION_DENIED'
      );
    END IF;

  END IF;

  ---------------------------------------------------------------------------
  -- 4. Resolve and lock the project.
  ---------------------------------------------------------------------------

  SELECT
    p.id,
    p.status
  INTO
    v_project_id,
    v_status
  FROM public.projects p
  WHERE p.public_id = v_public_id
    AND p.deleted_at IS NULL
  FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_NOT_FOUND'
    );
  END IF;

  IF v_status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_PROJECT_STATE',
      'status',
      v_status
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 5. Only one active participant preview per project.
  ---------------------------------------------------------------------------

  SELECT pg_catalog.count(*)
    INTO v_existing_active_count
    FROM public.participant_previews
   WHERE project_id = v_project_id
     AND status = 'active';

  IF v_existing_active_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'ACTIVE_PREVIEW_EXISTS'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 6. Correction workflow enforcement.
  ---------------------------------------------------------------------------

  SELECT pg_catalog.count(*)
    INTO v_open_correction_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp
      ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project_id
     AND r.status IN ('open', 'in_progress');

  IF COALESCE(p_is_correction_reissue, false) THEN

    IF v_open_correction_count > 1 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'AMBIGUOUS_CORRECTION_REQUEST'
      );

    ELSIF v_open_correction_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'NO_CORRECTION_IN_PROGRESS'
      );
    END IF;

    SELECT r.id
      INTO v_in_progress_correction_id
      FROM public.participant_preview_correction_requests r
      JOIN public.participant_previews pp
        ON pp.id = r.participant_preview_id
     WHERE pp.project_id = v_project_id
       AND r.status = 'in_progress'
     FOR UPDATE OF r;

    IF v_in_progress_correction_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'NO_CORRECTION_IN_PROGRESS'
      );
    END IF;

  ELSE

    IF v_open_correction_count > 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'CORRECTION_RESOLUTION_REQUIRED'
      );
    END IF;

  END IF;

  ---------------------------------------------------------------------------
  -- 6b. Task 3 multi-image accessibility gate.
  --
  -- Fail closed if ANY private snapshot that would be captured by this
  -- preview lacks usable authoritative alt text.
  ---------------------------------------------------------------------------

  IF EXISTS (
    SELECT 1
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id
       AND ma.asset_type = 'snapshot_image'
       AND ma.storage_bucket = v_private_bucket
       AND ma.is_public_approved = false
       AND ma.public_url IS NULL
       AND (
         pg_catalog.btrim(
           COALESCE(ma.alt_text_public, '')
         ) = ''
         OR pg_catalog.length(
           pg_catalog.btrim(ma.alt_text_public)
         ) > 2000
       )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'MEDIA_ACCESSIBILITY_REQUIRED'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 7. Immutable project snapshot.
  ---------------------------------------------------------------------------

  SELECT pg_catalog.jsonb_build_object(
      'title', p.title,
      'summary', p.summary,
      'background', p.background,
      'solution', p.solution,
      'year', p.year,
      'program', p.program_name,
      'studyProgram', p.study_program,
      'discipline', p.discipline,
      'industry', p.industry,
      'industryPartner', p.industry_partner,
      'academicSupervisor', p.academic_supervisor,
      'groupName', p.group_name,
      'teamMembers',
        pg_catalog.to_jsonb(
          COALESCE(p.team_members, '{}'::text[])
        ),
      'posterText', p.poster_text_public,
      'accessibilityText', p.accessibility_text_public,
      'citations',
        pg_catalog.to_jsonb(
          COALESCE(p.citations, '{}'::text[])
        ),
      'externalLinks',
        COALESCE(
          p.external_links,
          '[]'::jsonb
        ),
      'disciplines',
        COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              d.name
              ORDER BY d.name
            )
              FROM public.project_disciplines pd
              JOIN public.disciplines d
                ON d.id = pd.discipline_id
             WHERE pd.project_id = p.id
          ),
          '[]'::jsonb
        ),
      'industryCategories',
        COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              ic.name
              ORDER BY ic.name
            )
              FROM public.project_industry_categories pic
              JOIN public.industry_categories ic
                ON ic.id = pic.industry_category_id
             WHERE pic.project_id = p.id
          ),
          '[]'::jsonb
        )
    )
    INTO v_snapshot
    FROM public.projects p
   WHERE p.id = v_project_id;

  ---------------------------------------------------------------------------
  -- Task 3 immutable media snapshot.
  --
  -- galleryPosition is structurally present for every media element:
  --
  --   poster_image  -> null
  --   poster_pdf    -> null
  --   snapshot_image -> authoritative gallery_position
  --
  -- Snapshot images are captured in numeric gallery order. The order becomes
  -- immutable evidence of exactly what the participant was asked to confirm.
  ---------------------------------------------------------------------------

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mediaAssetId',
          ma.id,

        'assetType',
          ma.asset_type,

        'galleryPosition',
          CASE
            WHEN ma.asset_type = 'snapshot_image'
              THEN ma.gallery_position
            ELSE NULL
          END,

        'fileName',
          ma.file_name,

        'storageBucket',
          ma.storage_bucket,

        'storagePath',
          ma.storage_path,

        'mimeType',
          ma.mime_type,

        'altText',
          ma.alt_text_public
      )
      ORDER BY
        CASE ma.asset_type
          WHEN 'poster_image' THEN 1
          WHEN 'poster_pdf' THEN 2
          WHEN 'snapshot_image' THEN 3
          ELSE 4
        END,

        CASE
          WHEN ma.asset_type = 'snapshot_image'
            THEN ma.gallery_position
          ELSE NULL
        END,

        ma.id
    ),
    '[]'::jsonb
  )
  INTO v_media_snapshot
  FROM public.media_assets ma
  WHERE ma.project_id = v_project_id
    AND ma.storage_bucket = v_private_bucket
    AND ma.is_public_approved = false
    AND ma.public_url IS NULL;

  ---------------------------------------------------------------------------
  -- Store immutable preview.
  ---------------------------------------------------------------------------

  v_now := pg_catalog.now();

  v_expires_at :=
    v_now
    + pg_catalog.make_interval(
        secs => v_expires_in
      );

  BEGIN

    INSERT INTO public.participant_previews (
      project_id,
      token_hash,
      snapshot,
      media_snapshot,
      status,
      created_by,
      created_at,
      expires_at
    )
    VALUES (
      v_project_id,
      p_token_hash,
      v_snapshot,
      v_media_snapshot,
      'active',
      p_admin_id,
      v_now,
      v_expires_at
    )
    RETURNING id
         INTO v_preview_id;

  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'ACTIVE_PREVIEW_EXISTS'
      );
  END;

  ---------------------------------------------------------------------------
  -- 8. Correction reissue resolution.
  ---------------------------------------------------------------------------

  IF COALESCE(p_is_correction_reissue, false)
     AND v_in_progress_correction_id IS NOT NULL THEN

    UPDATE public.participant_preview_correction_requests
       SET status = 'resolved',
           resolved_at = v_now,
           resolved_by = p_admin_id,
           replacement_preview_id = v_preview_id
     WHERE id = v_in_progress_correction_id;

  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode',
      'SUCCESS',

    'previewId',
      v_preview_id,

    'publicId',
      v_public_id,

    'createdAt',
      pg_catalog.to_jsonb(v_now)::text,

    'expiresAt',
      pg_catalog.to_jsonb(v_expires_at)::text
  );
END;
$$;

-------------------------------------------------------------------------------
-- Keep participant-preview generation service-role-only.
-------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
FROM anon;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
FROM authenticated;

GRANT EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
TO service_role;

-------------------------------------------------------------------------------
-- The existing 5-argument wrapper delegates to the 6-argument implementation.
-- Re-assert its privileges so the legacy callable path cannot bypass the new
-- gallery-aware implementation.
-------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
FROM anon;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
FROM authenticated;

GRANT EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
TO service_role;

COMMIT;