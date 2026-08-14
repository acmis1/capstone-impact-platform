-- Migration: 20260814140000_snapshot_image_alt_text.sql
-- Description: Authoritative staff-authored alt text for the current snapshot image, enforced
-- across media staging, review submission, approval, participant preview generation and
-- publication readiness.
--
-- Migration 0025 (20260814090000_accessible_full_text_gate.sql) made project-level poster full text
-- and poster accessibility text mandatory. It deliberately did not cover per-image alt text for
-- snapshot media, so a snapshot image could still be participant-confirmed and published with no
-- text alternative at all — the Admin preview merely showed a filename-derived fallback, which is
-- file information rather than accessibility evidence.
--
-- This migration closes that gap for the one snapshot image the repository currently recognises
-- (snapshot-1.png -> at most one 'snapshot_image' row per project, under the existing
-- media_assets_project_asset_type_unique contract). The storage shape is per media asset rather
-- than per project, so it extends naturally to additional media later; no gallery support,
-- ordering, or multi-snapshot recognition is introduced here.
--
-- Rules-first and staff-authored throughout. Nothing in this migration derives alt text from a
-- filename, a project title, the poster accessibility text, OCR, or any AI service, and no existing
-- NULL is backfilled. The only rules are: present when a snapshot image exists, non-blank after
-- trim, and within a bounded technical ceiling. Nothing is ever silently truncated.
--
-- Functions forward-redefined here, each from its current authoritative definition:
--   finalize_browser_import_media_stage  <- 20260810120000_atomic_browser_import_media_stage.sql
--   submit_import_projects_for_review    <- 20260814090000_accessible_full_text_gate.sql
--   perform_project_review_action        <- 20260814090000_accessible_full_text_gate.sql
--   generate_participant_preview (6-arg) <- 20260811130000_participant_preview_correction_resolution.sql
--   get_project_publication_readiness    <- 20260814090000_accessible_full_text_gate.sql
--
-- Deliberately NOT redefined:
--   generate_participant_preview (5-arg) — the legacy wrapper delegates to the 6-arg implementation
--     with p_is_correction_reissue = false, so CREATE OR REPLACE of that implementation gives the
--     wrapper the new gate automatically. Its grants are re-asserted below rather than rewritten.
--   generate_participant_preview_with_notification — composes the 6-arg generator and inherits the
--     gate for the same reason. Its notification, recipient-authority and raw-token-non-persistence
--     behaviour is untouched.

BEGIN;

--------------------------------------------------------------------------------
-- 1. Media-level alt text column.
--
--    Nullable by necessity, not by laxity. NULL is the correct and only honest representation for:
--      * poster_pdf and any non-image asset, which have no alt text;
--      * poster_image, whose canonical text alternative stays the project-level
--        accessibility_text_public and is deliberately not duplicated here;
--      * a legacy project.json snapshot staged before staff supplied a description.
--    The workflow gates added further down are what stop a NULL snapshot alt from progressing.
--
--    The constraint permits NULL but never a blank or oversized value, so a row that carries a
--    value at all carries a usable one. 2000 characters mirrors
--    ACCESSIBLE_CONTENT_LIMITS.snapshotAltText in the application.
--------------------------------------------------------------------------------
ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS alt_text_public TEXT;

COMMENT ON COLUMN public.media_assets.alt_text_public IS
  'Staff-authored text alternative describing this media asset. Required for snapshot_image before the project may progress through review, approval, participant preview or publication. NULL for poster_pdf and for poster_image (whose text alternative is the project-level accessibility_text_public). Never derived from a filename, title, OCR or AI.';

ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS check_media_asset_alt_text_public;

ALTER TABLE public.media_assets
  ADD CONSTRAINT check_media_asset_alt_text_public CHECK (
    alt_text_public IS NULL
    OR (
      pg_catalog.btrim(alt_text_public) <> ''
      AND pg_catalog.length(pg_catalog.btrim(alt_text_public)) <= 2000
    )
  );

--------------------------------------------------------------------------------
-- 2. finalize_browser_import_media_stage
--    Forward-redefined from 20260810120000_atomic_browser_import_media_stage.sql (the current
--    authoritative definition). Every inherited guarantee is preserved: intent-hash validation,
--    batch advisory lock, idempotency ledger with INTENT_MISMATCH on divergence, administrator
--    validation, batch state requirement, metadata-commit binding, asset-array bounds, per-asset
--    field/type/size validation, duplicate-asset rejection, cross-batch protection, deterministic
--    convergence checking, ledger insertion and batch completion.
--
--    The single addition is the snapshot alt text, taken from the asset payload the server derived
--    by reparsing the uploaded package. The browser has no field through which it can supply this
--    value, and it is bound into the canonical media intent hash on the application side, so a
--    changed alt yields a different intent and cannot be smuggled into an already-completed batch.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_browser_import_media_stage(
  p_batch_id uuid,
  p_media_intent_hash text,
  p_metadata_intent_hash text,
  p_completed_by_id uuid,
  p_assets jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_media_intent_hash text;
  v_metadata_intent_hash text;
  v_existing_ledger RECORD;
  v_batch RECORD;
  v_commit_binding RECORD;
  v_admin_count integer;
  v_asset_count integer;
  v_asset jsonb;
  v_public_id text;
  v_package_path text;
  v_asset_type text;
  v_file_name text;
  v_storage_bucket text;
  v_storage_path text;
  v_mime_type text;
  v_alt_text text;
  v_file_size_bytes bigint;
  v_project RECORD;
  v_existing_asset RECORD;
  v_registered_count integer := 0;
  v_seen_asset_keys text[] := ARRAY[]::text[];
  v_asset_key text;
BEGIN
  -- 1. Top-level parameter validation
  v_media_intent_hash := pg_catalog.btrim(COALESCE(p_media_intent_hash, ''));
  v_metadata_intent_hash := pg_catalog.btrim(COALESCE(p_metadata_intent_hash, ''));

  IF v_media_intent_hash !~ '^[a-f0-9]{64}$' OR v_metadata_intent_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INTENT');
  END IF;

  IF p_batch_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'BATCH_NOT_FOUND');
  END IF;

  -- 2. Transaction lock keyed on batch id & idempotency check
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_batch_id::text));

  SELECT c.batch_id, c.media_intent_hash, c.asset_count
    INTO v_existing_ledger
    FROM public.browser_import_media_commits AS c
   WHERE c.batch_id = p_batch_id;

  IF FOUND THEN
    IF v_existing_ledger.media_intent_hash <> v_media_intent_hash THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INTENT_MISMATCH');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'SUCCESS',
      'result', 'already_completed',
      'batchId', p_batch_id,
      'mediaAssetCount', v_existing_ledger.asset_count,
      'batchStatus', 'completed'
    );
  END IF;

  -- 3. Validate acting administrator
  IF p_completed_by_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  SELECT pg_catalog.count(*) INTO v_admin_count
    FROM public.admin_users AS u
   WHERE u.id = p_completed_by_id;

  IF v_admin_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  -- 4. Fetch batch row and verify state
  SELECT b.id, b.status INTO v_batch
    FROM public.import_batches AS b
   WHERE b.id = p_batch_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'BATCH_NOT_FOUND');
  END IF;

  IF v_batch.status <> 'metadata_staged' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_BATCH_STATE');
  END IF;

  -- 5. Verify binding to the canonical metadata-stage commit for this batch
  --    (defense in depth; the caller already re-validates this server-side before calling)
  SELECT bic.batch_id, bic.intent_hash INTO v_commit_binding
    FROM public.browser_import_commits AS bic
   WHERE bic.batch_id = p_batch_id;

  IF NOT FOUND OR v_commit_binding.intent_hash <> v_metadata_intent_hash THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INTENT_BINDING_MISMATCH');
  END IF;

  -- 6. Asset array validation (MAX 75 = 25 packages * 3 media files)
  IF p_assets IS NULL OR pg_catalog.jsonb_typeof(p_assets) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  v_asset_count := pg_catalog.jsonb_array_length(p_assets);
  IF v_asset_count = 0 OR v_asset_count > 75 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  --------------------------------------------------------------------------------
  -- ALL VALIDATION PASSED BEFORE MUTATIONS BEGIN.
  -- AFTER THIS POINT, ANY UNEXPECTED FAILURE MUST RAISE AN EXCEPTION TO ROLL BACK.
  --------------------------------------------------------------------------------

  FOR v_asset IN SELECT * FROM pg_catalog.jsonb_array_elements(p_assets) LOOP
    IF pg_catalog.jsonb_typeof(v_asset) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_ASSET_SHAPE';
    END IF;

    v_public_id := pg_catalog.btrim(COALESCE(v_asset->>'projectPublicId', ''));
    v_package_path := pg_catalog.btrim(COALESCE(v_asset->>'packagePath', ''));
    v_asset_type := pg_catalog.btrim(COALESCE(v_asset->>'assetType', ''));
    v_file_name := pg_catalog.btrim(COALESCE(v_asset->>'fileName', ''));
    v_storage_bucket := pg_catalog.btrim(COALESCE(v_asset->>'storageBucket', ''));
    v_storage_path := pg_catalog.btrim(COALESCE(v_asset->>'storagePath', ''));
    v_mime_type := pg_catalog.btrim(COALESCE(v_asset->>'mimeType', ''));

    IF v_public_id = '' OR v_package_path = '' OR v_file_name = '' OR v_storage_bucket = '' OR v_storage_path = '' THEN
      RAISE EXCEPTION 'INVALID_ASSET_FIELDS';
    END IF;

    IF v_asset_type NOT IN ('poster_image', 'poster_pdf', 'snapshot_image') THEN
      RAISE EXCEPTION 'INVALID_ASSET_TYPE';
    END IF;

    -- Snapshot alt text, as derived server-side from the reparsed package. Absent stays absent: a
    -- legacy project.json snapshot with no description registers with a NULL alt and is held by the
    -- downstream gates until staff supply one, rather than being blocked from staging or given an
    -- invented value. A value that IS present must be usable, and only a snapshot image may carry
    -- one, so a caller cannot smuggle alt text onto the poster and bypass the project-level field.
    v_alt_text := NULLIF(pg_catalog.btrim(COALESCE(v_asset->>'snapshotAltText', '')), '');

    IF v_alt_text IS NOT NULL THEN
      IF v_asset_type <> 'snapshot_image' THEN
        RAISE EXCEPTION 'INVALID_ASSET_ALT_TEXT';
      END IF;
      IF pg_catalog.length(v_alt_text) > 2000 THEN
        RAISE EXCEPTION 'INVALID_ASSET_ALT_TEXT';
      END IF;
    END IF;

    IF NOT (v_asset ? 'fileSizeBytes') OR pg_catalog.jsonb_typeof(v_asset->'fileSizeBytes') <> 'number' THEN
      RAISE EXCEPTION 'INVALID_ASSET_SIZE';
    END IF;
    v_file_size_bytes := (v_asset->>'fileSizeBytes')::bigint;
    IF v_file_size_bytes <= 0 THEN
      RAISE EXCEPTION 'INVALID_ASSET_SIZE';
    END IF;

    -- Reject duplicate assets within the same request payload
    v_asset_key := v_public_id || '::' || v_asset_type;
    IF v_asset_key = ANY(v_seen_asset_keys) THEN
      RAISE EXCEPTION 'DUPLICATE_ASSET_IN_REQUEST';
    END IF;
    v_seen_asset_keys := pg_catalog.array_append(v_seen_asset_keys, v_asset_key);

    -- Resolve the project and require it to belong to THIS batch (cross-batch protection)
    SELECT p.id INTO v_project
      FROM public.projects AS p
     WHERE p.public_id = v_public_id
       AND p.import_batch_id = p_batch_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_NOT_IN_BATCH';
    END IF;

    -- Register the media asset row (idempotent no-op if an identical row already exists)
    INSERT INTO public.media_assets (
      project_id,
      asset_type,
      file_name,
      storage_bucket,
      storage_path,
      public_url,
      mime_type,
      file_size_bytes,
      is_public_approved,
      alt_text_public
    ) VALUES (
      v_project.id,
      v_asset_type,
      v_file_name,
      v_storage_bucket,
      v_storage_path,
      NULL,
      NULLIF(v_mime_type, ''),
      v_file_size_bytes,
      false,
      v_alt_text
    )
    ON CONFLICT (project_id, asset_type) DO NOTHING;

    -- Verify convergence: the row for (project, assetType) must point at exactly this object and
    -- carry exactly this alt text. ON CONFLICT DO NOTHING deliberately never overwrites an existing
    -- row, so this is what proves a retry converged rather than silently diverging — an alt text
    -- edited through the staff workflow after staging would surface here rather than be clobbered.
    -- IS DISTINCT FROM, not <>, because both sides are legitimately nullable.
    SELECT ma.storage_bucket, ma.storage_path, ma.alt_text_public INTO v_existing_asset
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id
       AND ma.asset_type = v_asset_type;

    IF NOT FOUND
       OR v_existing_asset.storage_bucket <> v_storage_bucket
       OR v_existing_asset.storage_path <> v_storage_path
       OR v_existing_asset.alt_text_public IS DISTINCT FROM v_alt_text THEN
      RAISE EXCEPTION 'MEDIA_ASSET_CONFLICT';
    END IF;

    v_registered_count := v_registered_count + 1;
  END LOOP;

  -- 7. Create the idempotency ledger row for this batch
  INSERT INTO public.browser_import_media_commits (
    batch_id,
    media_intent_hash,
    metadata_intent_hash,
    asset_count,
    completed_by
  ) VALUES (
    p_batch_id,
    v_media_intent_hash,
    v_metadata_intent_hash,
    v_registered_count,
    p_completed_by_id
  );

  -- 8. Complete the batch. Projects are intentionally left untouched (remain 'draft').
  UPDATE public.import_batches
     SET status = 'completed'
   WHERE id = p_batch_id
     AND status = 'metadata_staged';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BATCH_STATE_CHANGED_CONCURRENTLY';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'result', 'completed',
    'batchId', p_batch_id,
    'mediaAssetCount', v_registered_count,
    'batchStatus', 'completed'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) TO service_role;

--------------------------------------------------------------------------------
-- 3. update_snapshot_image_alt_text — new privileged staff mutation.
--
--    Mirrors update_project_metadata's authority model exactly: service-role-only execution,
--    Admin/Editor (projects.edit) rechecked inside the database rather than trusted from the
--    caller, reviewer-only identities denied, project resolved by public_id and row-locked, and the
--    project's own updated_at used as the optimistic-concurrency boundary.
--
--    Sharing that boundary is deliberate. The metadata editor and this editor both act on the same
--    project detail view, so a stale tab in either surface must lose rather than silently overwrite
--    the other's work. On success the project's updated_at is touched even though no project column
--    changed, so the two editors stay on one coherent version line — and so a snapshot alt edit
--    invalidates any participant confirmation exactly like a metadata edit does.
--
--    Every failure path returns before any mutation and therefore writes zero audit rows.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_snapshot_image_alt_text(
  p_public_id text,
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
  -- 1. Input validation
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- The only content rules are presence after trim and the technical ceiling. Nothing here judges
  -- whether the prose is a good description, and an oversized value is rejected outright rather
  -- than truncated to fit.
  v_alt_text := pg_catalog.btrim(COALESCE(p_alt_text, ''));
  IF v_alt_text = '' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;
  IF pg_catalog.length(v_alt_text) > 2000 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALT_TEXT_TOO_LONG');
  END IF;

  -- 2. Authorization: editing accessibility metadata is an editing action, not a review action.
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL
     OR pg_catalog.cardinality(v_roles) = 0
     OR NOT ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles)) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- 3. Resolve and lock the project
  SELECT p.id, p.status, p.updated_at
    INTO v_project_id, v_status, v_current_updated_at
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  -- 4. Workflow state. An approved project must be reopened through the ordinary Request changes
  -- workflow first, so that revoking the participant preview and re-obtaining confirmation happens
  -- through the reviewed path. A published project's accessibility metadata is public evidence and
  -- is never altered outside controlled publication state.
  IF v_status = 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'APPROVAL_REOPEN_REQUIRED');
  END IF;
  IF v_status = 'published' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLISHED_PROJECT_LOCKED');
  END IF;

  -- 5. Optimistic concurrency against the shared project-detail version boundary.
  IF v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION');
  END IF;

  -- 6. Resolve the target media row. It must belong to THIS project and must be the snapshot image:
  -- the poster image's text alternative is the project-level accessibility_text_public and is never
  -- editable through this path.
  SELECT ma.id, ma.alt_text_public
    INTO v_media_id, v_old_alt_text
    FROM public.media_assets ma
   WHERE ma.project_id = v_project_id
     AND ma.asset_type = 'snapshot_image'
     FOR UPDATE;

  IF v_media_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SNAPSHOT_MEDIA_NOT_FOUND');
  END IF;

  -- 7. A no-op is not an edit: it must not touch the project version and must not fabricate audit
  -- evidence of a change that did not happen.
  IF v_old_alt_text IS NOT DISTINCT FROM v_alt_text THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'NO_CHANGES',
      'snapshotAltText', v_alt_text,
      'mediaAssetId', v_media_id::text,
      'expectedUpdatedAt', v_current_updated_at
    );
  END IF;

  SELECT u.full_name, u.email
    INTO v_actor_full_name, v_actor_email
    FROM public.admin_users u
   WHERE u.id = p_admin_id;

  --------------------------------------------------------------------------------
  -- ALL VALIDATION PASSED BEFORE MUTATIONS BEGIN.
  --------------------------------------------------------------------------------

  UPDATE public.media_assets
     SET alt_text_public = v_alt_text
   WHERE id = v_media_id;

  -- Deliberately touch the project so both project-detail editors share one version line and any
  -- participant confirmation of the previous state is invalidated.
  UPDATE public.projects
     SET updated_at = pg_catalog.now()
   WHERE id = v_project_id
  RETURNING updated_at INTO v_updated_at;

  -- Audit evidence. The action stays 'update_metadata' — already permitted by the
  -- check_audit_action constraint and already understood by every existing reader — while the
  -- event_details carry a distinctly typed media_accessibility contract that names the exact media
  -- asset. Stuffing media-specific identity into the project_metadata schema would misreport which
  -- thing changed, so the two contracts are kept separate and parsed as a discriminated union.
  v_event_details := pg_catalog.jsonb_build_object(
    'version', 1,
    'type', 'media_accessibility',
    'mediaAssetId', v_media_id::text,
    'assetType', 'snapshot_image',
    'changedFields', pg_catalog.to_jsonb(ARRAY['snapshotAltText']),
    'before', pg_catalog.jsonb_build_object('snapshotAltText', v_old_alt_text),
    'after', pg_catalog.jsonb_build_object('snapshotAltText', v_alt_text)
  );

  INSERT INTO public.approval_records(
    project_id, admin_id, action_taken, from_status, to_status, comments,
    actor_full_name_snapshot, actor_email_snapshot, event_details
  ) VALUES (
    v_project_id, p_admin_id, 'update_metadata', v_status, v_status,
    'Updated snapshot image alt text.', v_actor_full_name, v_actor_email, v_event_details
  ) RETURNING id INTO v_audit_record_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'snapshotAltText', v_alt_text,
    'mediaAssetId', v_media_id::text,
    'expectedUpdatedAt', v_updated_at,
    'auditRecordId', v_audit_record_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_snapshot_image_alt_text(text, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_snapshot_image_alt_text(text, text, timestamptz, uuid) TO service_role;

--------------------------------------------------------------------------------
-- 4. submit_import_projects_for_review
--    Forward-redefined from 20260814090000_accessible_full_text_gate.sql (the current authoritative
--    definition). Every inherited guarantee is preserved verbatim: Admin/Editor submit authority
--    with reviewer denial, batch advisory lock, completed-batch requirement, selection
--    canonicalisation and bounds, deterministic project locking, all-or-nothing behaviour,
--    idempotent already-submitted handling, validation errors/flags, discipline/industry mappings,
--    private poster image/PDF checks, poster full text and accessibility text gates, audit rows and
--    concurrency defenses.
--
--    The addition is conditional and evaluated inside the existing pre-mutation readiness pass, so
--    a single non-compliant project in a mixed selection aborts the entire call with zero status
--    transitions and zero submit audit rows.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_import_projects_for_review(
  p_batch_id uuid,
  p_project_public_ids text[],
  p_admin_id uuid,
  p_comments text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comments text;
  v_roles text[];
  v_batch RECORD;
  v_canonical_ids text[];
  v_id_count integer;
  v_matched_count integer;
  v_project RECORD;
  v_discipline_count integer;
  v_industry_count integer;
  v_poster_ok boolean;
  v_poster_pdf_ok boolean;
  v_snapshot RECORD;
  v_unresolved_error_flag_count integer;
  v_blocking_reasons text[];
  v_to_submit uuid[] := ARRAY[]::uuid[];
  v_to_submit_from_status jsonb := '{}'::jsonb;
  v_already_submitted text[] := ARRAY[]::text[];
  v_results jsonb := '[]'::jsonb;
  v_pid uuid;
  v_from_status text;
  v_public_id text;
  v_audit_id uuid;
  v_submitted_count integer := 0;
  v_locked_count integer := 0;
BEGIN
  -- 1. Top-level parameter validation
  IF p_batch_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'BATCH_NOT_FOUND');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SUBMIT_PERMISSION_DENIED');
  END IF;

  IF p_comments IS NOT NULL THEN
    v_comments := pg_catalog.btrim(p_comments);
    IF v_comments = '' THEN
      v_comments := NULL;
    END IF;
  ELSE
    v_comments := NULL;
  END IF;

  IF v_comments IS NOT NULL AND pg_catalog.length(v_comments) > 4000 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  -- 2. Transaction lock keyed on batch id (shared namespace with the media-stage finalize RPC
  --    is intentional defense-in-depth: the two operations can never legitimately overlap on
  --    the same batch, since one only runs pre-completion and the other only post-completion).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_batch_id::text));

  -- 3. Authorization defense-in-depth: submission is a preparation/editing action (projects.edit),
  --    never an approval action. A reviewer-only identity must not be able to submit.
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0
     OR NOT ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SUBMIT_PERMISSION_DENIED');
  END IF;

  -- 4. Fetch and lock the batch row; require it to be completed.
  SELECT b.id, b.status INTO v_batch
    FROM public.import_batches AS b
   WHERE b.id = p_batch_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'BATCH_NOT_FOUND');
  END IF;

  IF v_batch.status <> 'completed' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_BATCH_STATE');
  END IF;

  -- 5. Canonicalize / deduplicate selected project identifiers (order-independent, distinct).
  IF p_project_public_ids IS NULL
     OR pg_catalog.array_position(p_project_public_ids, NULL) IS NOT NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT ids.id ORDER BY ids.id)
    INTO v_canonical_ids
    FROM pg_catalog.unnest(p_project_public_ids) AS ids(id);

  v_id_count := COALESCE(pg_catalog.cardinality(v_canonical_ids), 0);
  IF v_id_count = 0 OR v_id_count > 25 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  -- 6. Lock every matching project row in deterministic (id) order — avoids deadlocks against
  --    concurrent overlapping selections and is the sole idempotency/convergence mechanism.
  SELECT pg_catalog.count(*) INTO v_matched_count
    FROM public.projects AS p
   WHERE p.public_id = ANY(v_canonical_ids)
     AND p.import_batch_id = p_batch_id
     AND p.deleted_at IS NULL;

  IF v_matched_count <> v_id_count THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_IN_BATCH');
  END IF;

  --------------------------------------------------------------------------------
  -- 7. Pre-mutation validation pass: derive eligibility + readiness for every selected
  --    project BEFORE any mutation. Any ineligible or unready project aborts the whole
  --    call with zero mutations (selection is all-or-nothing).
  --------------------------------------------------------------------------------
  FOR v_project IN
    SELECT p.id, p.public_id, p.status, p.title, p.summary, p.program_id,
           p.program_name, p.study_program, p.discipline, p.group_name, p.team_members,
           p.validation_errors, p.poster_text_public, p.accessibility_text_public
      FROM public.projects AS p
     WHERE p.public_id = ANY(v_canonical_ids)
       AND p.import_batch_id = p_batch_id
       AND p.deleted_at IS NULL
     ORDER BY p.id
       FOR UPDATE
  LOOP
    v_locked_count := v_locked_count + 1;

    IF v_project.status = 'submitted' THEN
      v_already_submitted := pg_catalog.array_append(v_already_submitted, v_project.public_id);
      CONTINUE;
    END IF;

    IF v_project.status NOT IN ('draft', 'changes_requested') THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'INVALID_PROJECT_STATE',
        'publicId', v_project.public_id,
        'status', v_project.status
      );
    END IF;

    -- Readiness re-derivation (server-authoritative; mirrors the application-side
    -- computeProjectReviewReadiness rules).
    v_blocking_reasons := ARRAY[]::text[];

    IF pg_catalog.btrim(COALESCE(v_project.title, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_TITLE');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.summary, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_SUMMARY');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.program_name, '')) = '' OR v_project.program_id IS NULL THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_PROGRAM');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.study_program, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_STUDY_PROGRAM');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.discipline, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_DISCIPLINE');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.group_name, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_GROUP_NAME');
    END IF;
    IF v_project.team_members IS NULL OR pg_catalog.cardinality(v_project.team_members) = 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_TEAM_MEMBERS');
    END IF;

    -- Accessible poster content. A legacy project.json package can reach the CMS without either
    -- value; it may be staged, but it may never enter review until staff supply both through the
    -- project metadata editor. The bound is re-derived from the persisted row rather than trusted
    -- from whatever wrote it, so a row that reached the table by any path is still checked here.
    IF pg_catalog.btrim(COALESCE(v_project.poster_text_public, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_POSTER_TEXT');
    ELSIF pg_catalog.length(pg_catalog.btrim(v_project.poster_text_public)) > 20000 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'POSTER_TEXT_TOO_LONG');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.accessibility_text_public, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_ACCESSIBILITY_TEXT');
    ELSIF pg_catalog.length(pg_catalog.btrim(v_project.accessibility_text_public)) > 2000 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'ACCESSIBILITY_TEXT_TOO_LONG');
    END IF;

    IF v_project.validation_errors IS NOT NULL AND pg_catalog.cardinality(v_project.validation_errors) > 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'BLOCKING_VALIDATION_ERRORS');
    END IF;

    -- Authoritative validation_flags: an unresolved error-severity flag blocks submission.
    -- Resolved flags, and warning/info severities regardless of resolution, are never blocking.
    SELECT pg_catalog.count(*) INTO v_unresolved_error_flag_count
      FROM public.validation_flags AS vf
     WHERE vf.project_id = v_project.id
       AND vf.severity = 'error'
       AND vf.resolved = false;
    IF v_unresolved_error_flag_count > 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'BLOCKING_VALIDATION_FLAGS');
    END IF;

    SELECT pg_catalog.count(*) INTO v_discipline_count
      FROM public.project_disciplines AS pd
     WHERE pd.project_id = v_project.id;
    IF v_discipline_count = 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_DISCIPLINE_MAPPING');
    END IF;

    SELECT pg_catalog.count(*) INTO v_industry_count
      FROM public.project_industry_categories AS pic
     WHERE pic.project_id = v_project.id;
    IF v_industry_count = 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_INDUSTRY_MAPPING');
    END IF;

    -- Staged media consistency: required private assets must be registered and must remain
    -- private (never public_url, never is_public_approved). Fail closed on inconsistency.
    SELECT pg_catalog.bool_or(ma.public_url IS NULL AND ma.is_public_approved = false)
      INTO v_poster_ok
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id AND ma.asset_type = 'poster_image';
    IF NOT COALESCE(v_poster_ok, false) THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_OR_INCONSISTENT_POSTER_MEDIA');
    END IF;

    SELECT pg_catalog.bool_or(ma.public_url IS NULL AND ma.is_public_approved = false)
      INTO v_poster_pdf_ok
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id AND ma.asset_type = 'poster_pdf';
    IF NOT COALESCE(v_poster_pdf_ok, false) THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_OR_INCONSISTENT_POSTER_PDF_MEDIA');
    END IF;

    -- Snapshot media accessibility, conditional by design. The snapshot image itself stays optional
    -- and its absence adds no blocker at all — the existing "snapshot gallery is empty" warning is
    -- unchanged. But once a snapshot image exists, it is an image bound for a public page, so it
    -- must carry a usable text alternative before the project can enter review. A legacy
    -- project.json snapshot staged with a NULL alt lands here and is held until staff supply one.
    SELECT ma.alt_text_public INTO v_snapshot
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id AND ma.asset_type = 'snapshot_image';

    IF FOUND THEN
      IF pg_catalog.btrim(COALESCE(v_snapshot.alt_text_public, '')) = '' THEN
        v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_SNAPSHOT_ALT_TEXT');
      ELSIF pg_catalog.length(pg_catalog.btrim(v_snapshot.alt_text_public)) > 2000 THEN
        v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'SNAPSHOT_ALT_TEXT_TOO_LONG');
      END IF;
    END IF;

    IF pg_catalog.cardinality(v_blocking_reasons) > 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'READINESS_BLOCKED',
        'publicId', v_project.public_id,
        'blockingReasons', pg_catalog.to_jsonb(v_blocking_reasons)
      );
    END IF;

    v_to_submit := pg_catalog.array_append(v_to_submit, v_project.id);
    v_to_submit_from_status := pg_catalog.jsonb_set(
      v_to_submit_from_status, ARRAY[v_project.id::text], pg_catalog.to_jsonb(v_project.status)
    );
  END LOOP;

  -- Defense against a project being concurrently soft-deleted (or moved out of this batch)
  -- between the pre-lock existence count (step 6) and this locking loop: the loop must have
  -- actually locked exactly the canonical selection, or the all-or-nothing guarantee is violated.
  IF v_locked_count <> v_id_count THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_IN_BATCH');
  END IF;

  --------------------------------------------------------------------------------
  -- ALL VALIDATION PASSED BEFORE MUTATIONS BEGIN.
  -- AFTER THIS POINT, ANY UNEXPECTED FAILURE MUST RAISE AN EXCEPTION TO ROLL BACK.
  --------------------------------------------------------------------------------

  FOREACH v_pid IN ARRAY v_to_submit LOOP
    v_from_status := v_to_submit_from_status->>(v_pid::text);

    UPDATE public.projects
       SET status = 'submitted'
     WHERE id = v_pid
       AND status = v_from_status
     RETURNING public_id INTO v_public_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_STATE_CHANGED_CONCURRENTLY';
    END IF;

    INSERT INTO public.approval_records (
      project_id, admin_id, action_taken, from_status, to_status, comments
    ) VALUES (
      v_pid, p_admin_id, 'submit_for_review', v_from_status, 'submitted', v_comments
    ) RETURNING id INTO v_audit_id;

    v_submitted_count := v_submitted_count + 1;
    v_results := v_results || pg_catalog.jsonb_build_object(
      'publicId', v_public_id,
      'fromStatus', v_from_status,
      'toStatus', 'submitted',
      'auditRecordId', v_audit_id::text
    );
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'batchId', p_batch_id,
    'submittedCount', v_submitted_count,
    'alreadySubmittedPublicIds', pg_catalog.to_jsonb(v_already_submitted),
    'results', v_results
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) TO service_role;

--------------------------------------------------------------------------------
-- 5. perform_project_review_action
--    Forward-redefined from 20260814090000_accessible_full_text_gate.sql (the current authoritative
--    definition, which itself inherited the controlled-public-removal protection and the
--    approval-edit-gate participant-preview/correction handling). ALL of that behaviour is
--    preserved verbatim: RBAC, valid transitions, correction-resolution blocking, active-preview
--    revocation on reopen, published-archive restriction, poster full text / accessibility text
--    approval gates, audit semantics and transactionality.
--
--    The single addition gates 'approve' only. request_changes and archive stay available
--    unchanged, precisely so staff can move a non-compliant project somewhere useful.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.perform_project_review_action(p_public_id text, p_action text, p_comments text, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text; v_comments text; v_roles text[]; v_project_id uuid; v_from_status text;
  v_to_status text; v_archive_reason text; v_now timestamptz; v_audit_record_id uuid;
  v_unresolved integer; v_active integer;
  v_poster_text text; v_accessibility_text text;
  v_snapshot RECORD;
BEGIN
  IF p_public_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  IF pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_INVALID'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('request_changes', 'approve', 'archive') THEN RAISE EXCEPTION 'REVIEW_ACTION_INVALID'; END IF;
  v_comments := NULLIF(pg_catalog.btrim(COALESCE(p_comments, '')), '');
  IF v_comments IS NOT NULL AND pg_catalog.length(v_comments) > 4000 THEN RAISE EXCEPTION 'REVIEW_COMMENTS_TOO_LONG'; END IF;
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'REVIEW_ADMIN_ID_REQUIRED'; END IF;
  SELECT pg_catalog.array_agg(r.role) INTO v_roles FROM public.user_roles r WHERE r.user_id = p_admin_id;
  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED'; END IF;
  IF p_action IN ('request_changes', 'approve') AND NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)) THEN RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED'; END IF;
  IF p_action = 'archive' AND NOT ('admin' = ANY(v_roles)) THEN RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED'; END IF;
  IF p_action = 'request_changes' THEN PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id)); END IF;
  SELECT p.id, p.status, p.poster_text_public, p.accessibility_text_public
    INTO v_project_id, v_from_status, v_poster_text, v_accessibility_text
    FROM public.projects p WHERE p.public_id = v_public_id AND p.deleted_at IS NULL FOR UPDATE;
  IF v_project_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PROJECT_NOT_FOUND'; END IF;
  IF v_from_status = 'published' AND p_action = 'archive' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED');
  END IF;
  IF v_from_status = 'approved' AND p_action = 'request_changes' THEN
    PERFORM pp.id FROM public.participant_previews pp WHERE pp.project_id = v_project_id AND pp.status = 'active' ORDER BY pp.id FOR UPDATE;
    SELECT count(*) INTO v_unresolved FROM public.participant_preview_correction_requests r JOIN public.participant_previews pp ON pp.id = r.participant_preview_id WHERE pp.project_id = v_project_id AND r.status IN ('open', 'in_progress');
    IF v_unresolved > 0 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'CORRECTION_RESOLUTION_REQUIRED'); END IF;
    SELECT count(*) INTO v_active FROM public.participant_previews WHERE project_id = v_project_id AND status = 'active';
    IF v_active > 1 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'AMBIGUOUS_ACTIVE_PREVIEW'); END IF;
    IF v_active = 1 THEN UPDATE public.participant_previews SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = p_admin_id WHERE project_id = v_project_id AND status = 'active'; END IF;
    v_to_status := 'changes_requested';
  ELSE
    CASE v_from_status
      WHEN 'submitted', 'in_review' THEN CASE p_action WHEN 'request_changes' THEN v_to_status := 'changes_requested'; WHEN 'approve' THEN v_to_status := 'approved'; WHEN 'archive' THEN v_to_status := 'archived'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END CASE;
      WHEN 'changes_requested' THEN IF p_action = 'approve' THEN v_to_status := 'approved'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;
      WHEN 'approved' THEN IF p_action = 'archive' THEN v_to_status := 'archived'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;
      ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
    END CASE;
  END IF;
  -- Approval is the last point at which a project can still be corrected cheaply, and it is the
  -- gate a caller could otherwise reach without ever passing through import-review preparation.
  -- Re-read from the locked row, so this holds regardless of how the project got here. Only
  -- 'approve' is gated: request_changes and archive must stay available precisely so staff can
  -- move a non-compliant project somewhere useful.
  --
  -- Absent and oversized are reported as distinct codes so staff are never told to shorten
  -- something that is missing, or to supply something that is merely too long.
  IF p_action = 'approve' THEN
    IF pg_catalog.btrim(COALESCE(v_poster_text, '')) = ''
       OR pg_catalog.btrim(COALESCE(v_accessibility_text, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED');
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(v_poster_text)) > 20000
       OR pg_catalog.length(pg_catalog.btrim(v_accessibility_text)) > 2000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_INVALID');
    END IF;
    -- Snapshot media accessibility, conditional on a snapshot image actually existing. Approval is
    -- what makes a project eligible for a participant preview, so a missing text alternative must
    -- be caught here rather than surfacing to a participant asked to confirm an undescribed image.
    SELECT ma.alt_text_public INTO v_snapshot
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id AND ma.asset_type = 'snapshot_image';
    IF FOUND AND pg_catalog.btrim(COALESCE(v_snapshot.alt_text_public, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'MEDIA_ACCESSIBILITY_REQUIRED');
    END IF;
    IF FOUND AND pg_catalog.length(pg_catalog.btrim(v_snapshot.alt_text_public)) > 2000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'MEDIA_ACCESSIBILITY_INVALID');
    END IF;
  END IF;
  v_now := pg_catalog.now();
  IF p_action = 'archive' THEN
    v_archive_reason := COALESCE(v_comments, 'Archived under standard review workflow');
    UPDATE public.projects SET status = v_to_status, archived_at = v_now, archived_from_status = v_from_status, archive_reason = v_archive_reason, pending_removal_from_public = true WHERE id = v_project_id;
  ELSIF p_action = 'approve' THEN UPDATE public.projects SET status = v_to_status, archived_at = NULL, archived_from_status = NULL, archive_reason = NULL WHERE id = v_project_id;
  ELSE UPDATE public.projects SET status = v_to_status WHERE id = v_project_id; END IF;
  INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments)
  VALUES (v_project_id, p_admin_id, p_action, v_from_status, v_to_status, v_comments) RETURNING id INTO v_audit_record_id;
  RETURN pg_catalog.jsonb_build_object('publicId', v_public_id, 'status', v_to_status, 'auditRecordId', v_audit_record_id::text);
END; $$;

REVOKE ALL ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) TO service_role;

--------------------------------------------------------------------------------
-- 6. generate_participant_preview (6-argument implementation)
--    Forward-redefined from 20260811130000_participant_preview_correction_resolution.sql (the
--    current authoritative definition; the email-notifications migration added a composing wrapper
--    but never redefined this function). Every inherited rule is preserved: token-hash format
--    validation with no raw-token persistence, approved-only generation, single active preview,
--    ordinary review authority, the stricter combined authority for a correction reissue,
--    unresolved-correction blocking, correction reissue resolution, immutable project snapshot,
--    private-media-only snapshot, unique-violation race handling and service-role execution.
--
--    Two additions:
--      * a fail-closed gate — a participant must never be asked to confirm a snapshot image whose
--        text alternative is missing or unusable;
--      * altText in the immutable media snapshot, so the value the participant actually confirmed
--        is preserved as evidence and participates in the publication-readiness staleness
--        comparison rather than being treated as mutable display metadata.
--------------------------------------------------------------------------------
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
  v_snapshot_media RECORD;
  v_has_edit boolean;
  v_has_review boolean;
BEGIN
  -- 1. Input validation
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_TOKEN_HASH');
  END IF;

  IF p_private_bucket IS NULL OR pg_catalog.btrim(p_private_bucket) = '' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PRIVATE_BUCKET');
  END IF;
  v_private_bucket := pg_catalog.btrim(p_private_bucket);

  v_expires_in := COALESCE(p_expires_in_seconds, 604800);
  IF v_expires_in < 3600 OR v_expires_in > 2592000 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_EXPIRY');
  END IF;

  -- 2. Advisory Lock Serialization
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization check
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  v_has_edit := ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles));
  v_has_review := ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles));

  IF COALESCE(p_is_correction_reissue, false) THEN
    -- Corrected reissue requires combined authority (projects.edit AND projects.review)
    IF NOT (v_has_edit AND v_has_review) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
    END IF;
  ELSE
    -- Ordinary generation requires review authority
    IF NOT v_has_review THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
    END IF;
  END IF;

  -- 4. Resolve and lock project
  SELECT p.id, p.status
    INTO v_project_id, v_status
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  IF v_status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PROJECT_STATE', 'status', v_status);
  END IF;

  -- 5. Active preview check
  SELECT pg_catalog.count(*)
    INTO v_existing_active_count
    FROM public.participant_previews
   WHERE project_id = v_project_id
     AND status = 'active';

  IF v_existing_active_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVE_PREVIEW_EXISTS');
  END IF;

  -- 6. Correction workflow enforcement
  -- Total unresolved count (open + in_progress)
  SELECT pg_catalog.count(*)
    INTO v_open_correction_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project_id
     AND r.status IN ('open', 'in_progress');

  IF COALESCE(p_is_correction_reissue, false) THEN
    -- Corrected reissue: total unresolved count must be exactly 1
    IF v_open_correction_count > 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'AMBIGUOUS_CORRECTION_REQUEST');
    ELSIF v_open_correction_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'NO_CORRECTION_IN_PROGRESS');
    END IF;

    -- Exactly 1 unresolved request exists. Inspect its status.
    SELECT r.id
      INTO v_in_progress_correction_id
      FROM public.participant_preview_correction_requests r
      JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
     WHERE pp.project_id = v_project_id
       AND r.status = 'in_progress'
       FOR UPDATE OF r;

    IF v_in_progress_correction_id IS NULL THEN
      -- The single unresolved request is 'open', not 'in_progress'
      RETURN pg_catalog.jsonb_build_object('resultCode', 'NO_CORRECTION_IN_PROGRESS');
    END IF;
  ELSE
    -- Ordinary generation: blocked if any unresolved correction exists
    IF v_open_correction_count > 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'CORRECTION_RESOLUTION_REQUIRED');
    END IF;
  END IF;

  -- 6b. Snapshot media accessibility gate. Fail closed BEFORE any preview row is created: a
  -- participant must never be asked to confirm an image with no usable text alternative, and a
  -- correction reissue must not carry a broken value forward either. Evaluated against the private
  -- media the preview would actually reference, so it matches the snapshot built below.
  SELECT ma.alt_text_public INTO v_snapshot_media
    FROM public.media_assets ma
   WHERE ma.project_id = v_project_id
     AND ma.asset_type = 'snapshot_image'
     AND ma.storage_bucket = v_private_bucket
     AND ma.is_public_approved = false
     AND ma.public_url IS NULL;

  IF FOUND THEN
    IF pg_catalog.btrim(COALESCE(v_snapshot_media.alt_text_public, '')) = ''
       OR pg_catalog.length(pg_catalog.btrim(v_snapshot_media.alt_text_public)) > 2000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'MEDIA_ACCESSIBILITY_REQUIRED');
    END IF;
  END IF;

  -- 7. Snapshot construction
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
      'teamMembers', pg_catalog.to_jsonb(COALESCE(p.team_members, '{}'::text[])),
      'posterText', p.poster_text_public,
      'accessibilityText', p.accessibility_text_public,
      'citations', pg_catalog.to_jsonb(COALESCE(p.citations, '{}'::text[])),
      'externalLinks', COALESCE(p.external_links, '[]'::jsonb),
      'disciplines', COALESCE((
        SELECT pg_catalog.jsonb_agg(d.name ORDER BY d.name)
          FROM public.project_disciplines pd
          JOIN public.disciplines d ON d.id = pd.discipline_id
         WHERE pd.project_id = p.id
      ), '[]'::jsonb),
      'industryCategories', COALESCE((
        SELECT pg_catalog.jsonb_agg(ic.name ORDER BY ic.name)
          FROM public.project_industry_categories pic
          JOIN public.industry_categories ic ON ic.id = pic.industry_category_id
         WHERE pic.project_id = p.id
      ), '[]'::jsonb)
    )
    INTO v_snapshot
    FROM public.projects p
   WHERE p.id = v_project_id;

  -- altText is structurally present for every media type so the shape is uniform, and is JSON null
  -- for poster_image and poster_pdf. The poster's text alternative deliberately stays the
  -- project-level accessibilityText captured in the snapshot above rather than being duplicated
  -- onto the media asset.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'mediaAssetId', ma.id,
      'assetType', ma.asset_type,
      'fileName', ma.file_name,
      'storageBucket', ma.storage_bucket,
      'storagePath', ma.storage_path,
      'mimeType', ma.mime_type,
      'altText', ma.alt_text_public
    )), '[]'::jsonb)
    INTO v_media_snapshot
    FROM public.media_assets ma
   WHERE ma.project_id = v_project_id
     AND ma.storage_bucket = v_private_bucket
     AND ma.is_public_approved = false
     AND ma.public_url IS NULL;

  v_now := pg_catalog.now();
  v_expires_at := v_now + pg_catalog.make_interval(secs => v_expires_in);

  BEGIN
    INSERT INTO public.participant_previews (
      project_id, token_hash, snapshot, media_snapshot, status, created_by, created_at, expires_at
    ) VALUES (
      v_project_id, p_token_hash, v_snapshot, v_media_snapshot, 'active', p_admin_id, v_now, v_expires_at
    ) RETURNING id INTO v_preview_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVE_PREVIEW_EXISTS');
  END;

  -- 8. If this was a correction reissue, complete the resolution transactionally
  IF COALESCE(p_is_correction_reissue, false) AND v_in_progress_correction_id IS NOT NULL THEN
    UPDATE public.participant_preview_correction_requests
       SET status = 'resolved',
           resolved_at = v_now,
           resolved_by = p_admin_id,
           replacement_preview_id = v_preview_id
     WHERE id = v_in_progress_correction_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'previewId', v_preview_id,
    'publicId', v_public_id,
    'createdAt', pg_catalog.to_jsonb(v_now)::text,
    'expiresAt', pg_catalog.to_jsonb(v_expires_at)::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) TO service_role;

-- The 5-argument legacy wrapper is intentionally NOT redefined: it delegates to the implementation
-- above with p_is_correction_reissue = false, so it now carries the same gate without a rewrite,
-- and no older callable signature can bypass the requirement. Its privileges are re-asserted here
-- so both intended signatures are verifiably service-role-only after this migration.
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) TO service_role;

--------------------------------------------------------------------------------
-- 7. get_project_publication_readiness
--    Forward-redefined from 20260814090000_accessible_full_text_gate.sql (the current authoritative
--    definition — NOT the original publication-readiness migration). Every invariant is preserved:
--    service-role-only execution, review authority, advisory lock, project row lock, the poster
--    full-text/accessibility gate, correction precedence, contradictory-response fail-closed
--    handling, active-preview cardinality, exact confirmation, corrected-preview handling, project
--    snapshot comparison, media snapshot comparison, malformed stored-snapshot handling, media
--    freshness and READY semantics.
--
--    Two additions:
--      * the current snapshot media alt text is gated in its own right, exactly like the poster
--        content gate above it. Snapshot comparison alone would not catch this: if the alt was
--        already missing when the preview was generated, the stored and current snapshots simply
--        agree on its absence and the project would sail through.
--      * altText participates in the media snapshot derivation, validation and comparison, so
--        editing it after confirmation makes the old confirmation stale rather than leaving it
--        able to authorise publication of a differently-described image.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_project_publication_readiness(
  p_public_id text,
  p_admin_id uuid,
  p_private_bucket text
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
  v_has_review boolean;
  v_project RECORD;
  v_active_preview RECORD;
  v_active_preview_count integer;
  v_confirmation RECORD;
  v_active_corr_count integer;
  v_unresolved_corr_count integer;
  v_replacement_count integer;
  v_invalid_media_element_count integer;
  v_snapshot_media RECORD;
  v_current_snapshot jsonb;
  v_current_media_snapshot jsonb;
  v_stored_media_snapshot jsonb;
  v_canonical_current_media jsonb;
  v_canonical_stored_media jsonb;
  v_accessibility_blockers text[];
  v_blockers text[];
BEGIN
  v_blockers := '{}'::text[];

  -- 1. Input Validation
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_NOT_FOUND',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project not found'])
    );
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_SELECTION',
      'blockers', pg_catalog.to_jsonb(ARRAY['Invalid project identifier'])
    );
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_PERMISSION_DENIED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Permission denied'])
    );
  END IF;

  IF p_private_bucket IS NULL OR pg_catalog.btrim(p_private_bucket) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PRIVATE_BUCKET',
      'blockers', pg_catalog.to_jsonb(ARRAY['Invalid private bucket configuration'])
    );
  END IF;
  v_private_bucket := pg_catalog.btrim(p_private_bucket);

  -- 2. Advisory Lock Serialization
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization Check. Readiness is review evidence, so review authority
  -- is sufficient; correction resolution retains its separate combined check.
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_PERMISSION_DENIED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Permission denied'])
    );
  END IF;

  v_has_review := ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles));

  IF NOT v_has_review THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_PERMISSION_DENIED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Permission denied'])
    );
  END IF;

  -- 4. Lock and inspect authoritative project
  SELECT p.*
    INTO v_project
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_NOT_FOUND',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project not found'])
    );
  END IF;

  -- Preserve meaningful correction workflow state ahead of generic project or
  -- preview-state outcomes. Resolution may revoke the old preview while the
  -- project awaits reapproval, but the correction is still unresolved.
  SELECT pg_catalog.count(*)
    INTO v_unresolved_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project.id
     AND r.status IN ('open', 'in_progress');

  -- A confirmed current preview with any correction row is contradictory
  -- persisted state. Check it before the legitimate lifecycle short-circuit.
  SELECT pg_catalog.count(*)
    INTO v_active_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
    JOIN public.participant_preview_confirmations c ON c.participant_preview_id = pp.id
   WHERE pp.project_id = v_project.id
     AND pp.status = 'active';

  IF v_active_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Active preview has contradictory participant responses'])
    );
  END IF;

  IF v_unresolved_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'CORRECTION_UNRESOLVED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant correction must be resolved']),
      'confirmedPreviewId', null,
      'confirmedAt', null
    );
  END IF;

  IF v_project.status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PROJECT_STATE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project status must be approved to evaluate publication readiness'])
    );
  END IF;

  -- 4b. Accessible poster content is a precondition of publication in its own right, evaluated
  -- against the locked project row rather than against any stored preview evidence. Both absence
  -- and oversize fail closed, and the diagnostic distinguishes them truthfully. Nothing is ever
  -- truncated to make a row publishable.
  v_accessibility_blockers := '{}'::text[];
  IF pg_catalog.btrim(COALESCE(v_project.poster_text_public, '')) = '' THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Poster full text is missing');
  ELSIF pg_catalog.length(pg_catalog.btrim(v_project.poster_text_public)) > 20000 THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Poster full text exceeds the 20,000 character safety limit');
  END IF;
  IF pg_catalog.btrim(COALESCE(v_project.accessibility_text_public, '')) = '' THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Accessibility text is missing');
  ELSIF pg_catalog.length(pg_catalog.btrim(v_project.accessibility_text_public)) > 2000 THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Accessibility text exceeds the 2,000 character safety limit');
  END IF;

  -- 4c. Snapshot media accessibility, evaluated against the current private media row for the same
  -- reason: a snapshot whose alt was already absent when the preview was issued would otherwise
  -- match its own stored snapshot and pass unnoticed.
  SELECT ma.alt_text_public INTO v_snapshot_media
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.asset_type = 'snapshot_image'
     AND ma.storage_bucket = v_private_bucket
     AND ma.is_public_approved = false
     AND ma.public_url IS NULL;

  IF FOUND THEN
    IF pg_catalog.btrim(COALESCE(v_snapshot_media.alt_text_public, '')) = '' THEN
      v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Snapshot image alt text is missing');
    ELSIF pg_catalog.length(pg_catalog.btrim(v_snapshot_media.alt_text_public)) > 2000 THEN
      v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Snapshot image alt text exceeds the 2,000 character safety limit');
    END IF;
  END IF;

  IF pg_catalog.cardinality(v_accessibility_blockers) > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED',
      'blockers', pg_catalog.to_jsonb(v_accessibility_blockers)
    );
  END IF;

  -- 5. Lock and inspect active participant preview. More than one active row
  -- is contradictory persisted state and must never select an arbitrary row.
  SELECT pg_catalog.count(*)
    INTO v_active_preview_count
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project.id
     AND pp.status = 'active';

  IF v_active_preview_count = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'NO_ACTIVE_PREVIEW',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant preview required'])
    );
  END IF;

  IF v_active_preview_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant preview state is ambiguous'])
    );
  END IF;

  SELECT pp.*
    INTO v_active_preview
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project.id
     AND pp.status = 'active'
     FOR UPDATE;

  -- 6. Check confirmation for active preview
  SELECT c.*
    INTO v_confirmation
    FROM public.participant_preview_confirmations c
   WHERE c.participant_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NULL THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Waiting for participant confirmation');
  END IF;

  -- 7. Any correction against a confirmed active preview is contradictory.
  SELECT pg_catalog.count(*)
    INTO v_active_corr_count
    FROM public.participant_preview_correction_requests r
   WHERE r.participant_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NOT NULL AND v_active_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Active preview has contradictory participant responses'])
    );
  END IF;

  -- 8. Check for unresolved (open or in_progress) correction requests across ALL previews of this project
  SELECT pg_catalog.count(*)
    INTO v_unresolved_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project.id
     AND r.status IN ('open', 'in_progress');

  IF v_unresolved_corr_count > 0 THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Participant correction must be resolved');
  END IF;

  IF v_unresolved_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'CORRECTION_UNRESOLVED',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  IF v_project.status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PROJECT_STATE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project status must be approved to evaluate publication readiness'])
    );
  END IF;

  -- A corrected replacement preview is identified from the persisted
  -- correction-resolution relationship, never browser state or history alone.
  SELECT pg_catalog.count(*)
    INTO v_replacement_count
    FROM public.participant_preview_correction_requests r
   WHERE r.status = 'resolved'
     AND r.replacement_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', CASE WHEN v_replacement_count = 1
        THEN 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION'
        WHEN v_replacement_count = 0 THEN 'PREVIEW_NOT_CONFIRMED'
        ELSE 'READINESS_UNAVAILABLE'
      END,
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', null,
      'confirmedAt', null
    );
  END IF;

  IF v_replacement_count > 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Correction replacement state is ambiguous'])
    );
  END IF;

  IF pg_catalog.jsonb_typeof(v_active_preview.snapshot) <> 'object'
     OR pg_catalog.jsonb_typeof(v_active_preview.media_snapshot) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview state is malformed'])
    );
  END IF;

  -- 9. Re-derive current canonical participant-facing project snapshot
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
      'teamMembers', pg_catalog.to_jsonb(COALESCE(p.team_members, '{}'::text[])),
      'posterText', p.poster_text_public,
      'accessibilityText', p.accessibility_text_public,
      'citations', pg_catalog.to_jsonb(COALESCE(p.citations, '{}'::text[])),
      'externalLinks', COALESCE(p.external_links, '[]'::jsonb),
      'disciplines', COALESCE((
        SELECT pg_catalog.jsonb_agg(d.name ORDER BY d.name)
          FROM public.project_disciplines pd
          JOIN public.disciplines d ON d.id = pd.discipline_id
         WHERE pd.project_id = p.id
      ), '[]'::jsonb),
      'industryCategories', COALESCE((
        SELECT pg_catalog.jsonb_agg(ic.name ORDER BY ic.name)
          FROM public.project_industry_categories pic
          JOIN public.industry_categories ic ON ic.id = pic.industry_category_id
         WHERE pic.project_id = p.id
      ), '[]'::jsonb)
    )
    INTO v_current_snapshot
    FROM public.projects p
   WHERE p.id = v_project.id;

  -- Compare project snapshot against stored active preview snapshot. posterText and
  -- accessibilityText are part of this canonical snapshot, so an accessible-content edit made
  -- after confirmation invalidates the confirmation exactly like any other content change.
  IF v_current_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project information changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 10. Re-derive current canonical private media snapshot. altText is part of the canonical shape,
  -- so a snapshot-alt edit made after confirmation surfaces as media staleness rather than being
  -- treated as display-only metadata outside the confirmed evidence.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'mediaAssetId', ma.id,
      'assetType', ma.asset_type,
      'fileName', ma.file_name,
      'storageBucket', ma.storage_bucket,
      'storagePath', ma.storage_path,
      'mimeType', ma.mime_type,
      'altText', ma.alt_text_public
    )), '[]'::jsonb)
    INTO v_current_media_snapshot
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.storage_bucket = v_private_bucket
     AND ma.is_public_approved = false
     AND ma.public_url IS NULL;

  -- Canonicalize both current and stored media snapshots for order-independent comparison
  SELECT COALESCE(pg_catalog.jsonb_agg(elem ORDER BY (elem->>'mediaAssetId')), '[]'::jsonb)
    INTO v_canonical_current_media
    FROM pg_catalog.jsonb_array_elements(v_current_media_snapshot) elem;

  v_stored_media_snapshot := COALESCE(v_active_preview.media_snapshot, '[]'::jsonb);

  -- A stored element must carry altText, and for a snapshot image it must be a usable string. For
  -- poster_image and poster_pdf, JSON null is the correct value. A preview issued before this
  -- migration has no altText key at all and is therefore malformed under the current contract:
  -- that fails closed and staff reissue the preview, rather than being silently compared against a
  -- differently-shaped current snapshot and reported as stale for the wrong reason.
  SELECT pg_catalog.count(*) INTO v_invalid_media_element_count
    FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem
   WHERE pg_catalog.jsonb_typeof(elem) <> 'object'
      OR pg_catalog.jsonb_typeof(elem->'mediaAssetId') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'assetType') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'fileName') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storageBucket') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storagePath') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'mimeType') <> 'string'
      OR NOT (elem ? 'altText')
      OR (elem->>'assetType' = 'snapshot_image' AND (
            pg_catalog.jsonb_typeof(elem->'altText') <> 'string'
            OR pg_catalog.btrim(COALESCE(elem->>'altText', '')) = ''
            OR pg_catalog.length(pg_catalog.btrim(elem->>'altText')) > 2000
          ))
      OR (elem->>'assetType' <> 'snapshot_image' AND pg_catalog.jsonb_typeof(elem->'altText') <> 'null');

  IF v_invalid_media_element_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview media state is malformed'])
    );
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(elem ORDER BY (elem->>'mediaAssetId')), '[]'::jsonb)
    INTO v_canonical_stored_media
    FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem;

  IF v_canonical_current_media IS DISTINCT FROM v_canonical_stored_media THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project media changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'MEDIA_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 11. All conditions satisfied -> READY
  RETURN pg_catalog.jsonb_build_object(
    'ready', true,
    'resultCode', 'READY',
    'blockers', '[]'::jsonb,
    'confirmedPreviewId', v_active_preview.id,
    'confirmedAt', v_confirmation.confirmed_at::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) TO service_role;

COMMIT;
