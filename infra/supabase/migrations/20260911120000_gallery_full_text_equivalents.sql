-- Migration 0057: 20260911120000_gallery_full_text_equivalents.sql
-- Description: Project-team-declared text-equivalent contract for every snapshot/gallery image.
--
-- The Project Brief requires each public project page to carry a full text version of ALL image
-- content, for accessibility and search optimisation. The poster already satisfies this through
-- poster_text_public plus accessibility_text_public. A gallery image only carried alt_text_public:
-- sufficient for an ordinary photograph, but not for a screenshot, slide, diagram, chart or
-- infographic whose meaningful content is text. This migration makes that distinction explicit and
-- authoritative data, and requires the full textual equivalent exactly when it applies.
--
-- Two additive, nullable columns on public.media_assets:
--   image_content_kind  'ordinary' | 'text_bearing' | NULL   (project-team declaration)
--   full_text_public    text | NULL                         (project-team-authored full text)
--
-- Semantics, enforced by the check constraint and re-derived by every workflow gate:
--   * NULL image_content_kind means "not yet declared". It is NEVER treated as an ordinary
--     photograph. Every existing snapshot row keeps NULL: there is no backfill, no copy of the alt
--     text into the full text, no OCR-derived value and no inference from filename or alt length.
--   * 'ordinary'     => full_text_public IS NULL.
--   * 'text_bearing' => full_text_public is trimmed, non-blank and at most 5000 characters
--                       (ACCESSIBLE_CONTENT_LIMITS.snapshotFullText in the application).
--   * Non-snapshot assets carry NULL in both columns.
--
-- Legacy / forward safety:
--   * Existing rows, storage objects, previews, confirmations, feed history and recovery evidence
--     are untouched. Undeclared snapshot media is surfaced as a blocker the next time its project
--     enters review submission, approval, participant-preview issuance, publication readiness or
--     deployment reconciliation. The only remedy is a corrected project-team package accepted by
--     staff; staff never author or rewrite this content.
--   * The immutable participant media snapshot gains 'contentKind' and 'fullText' on snapshot
--     elements only. Poster/PDF elements keep their exact historical shape, so a preview issued
--     before this migration for a project WITHOUT gallery images stays comparable; a preview with
--     gallery images is necessarily stale because the participant never confirmed a declaration.
--
-- Functions forward-redefined here, each from its current authoritative definition:
--   finalize_browser_import_media_stage   <- 20260824050000_multi_image_gallery.sql
--   submit_import_projects_for_review     <- 20260825025000_multi_image_gallery_review_submission.sql
--   perform_project_review_action         <- 20260824060000_multi_image_gallery_approval_gate.sql
--   generate_participant_preview (6-arg)  <- 20260903120000_participant_preview_controlled_links.sql
--   get_project_publication_readiness     <- 20260903120000_participant_preview_controlled_links.sql
--   get_project_reconciliation_readiness  <- 20260903120000_participant_preview_controlled_links.sql
--   reserve_participant_correction        <- 20260903130000_participant_owned_corrections.sql
--   review_participant_correction         <- 20260903130000_participant_owned_corrections.sql
--   get_release_capability_sentinel       <- 20260910120200_assistive_worker_production_identity.sql
--
-- Every inherited authorization, locking, idempotency, convergence, audit and transaction rule is
-- preserved verbatim; only the text-equivalent contract is added. No grant is broadened: workflow
-- RPCs stay SECURITY DEFINER with search_path = '' and service_role-only EXECUTE, while the release
-- sentinel keeps its inherited SECURITY INVOKER posture. The 5-arg
-- generate_participant_preview wrapper and generate_participant_preview_with_notification delegate
-- to the 6-arg implementation and inherit the gate; update_snapshot_image_alt_text is untouched
-- because the application already refuses direct staff edits of project-team content.

BEGIN;

--------------------------------------------------------------------------------
-- 1. Text-equivalent columns and their coherence constraint.
--------------------------------------------------------------------------------
ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS image_content_kind text;

ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS full_text_public text;

-- image_content_kind: project-team-declared classification of a snapshot_image — 'ordinary' (a
-- photograph whose alt text is its complete text alternative) or 'text_bearing' (a screenshot,
-- slide, diagram, chart or infographic that requires a full textual equivalent). NULL means "not
-- yet declared", blocks review submission, approval, participant preview and publication, and is
-- never treated as ordinary. NULL for every non-snapshot asset. Never inferred from a filename,
-- OCR, alt-text length or any AI service.
--
-- full_text_public: project-team-authored, searchable/selectable full textual equivalent of a
-- text_bearing snapshot_image, published alongside its alt text. Required exactly when
-- image_content_kind = 'text_bearing'; NULL otherwise. Never derived from OCR or any AI service,
-- never copied from the alt text.
--
-- (Documented as SQL comments rather than COMMENT ON so the managed-schema recovery inventory,
-- which scans migration DDL textually, is not confused by the storage.* references that the
-- forward-redefined correction RPCs below legitimately contain.)

ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS check_media_asset_gallery_text_equivalent;

ALTER TABLE public.media_assets
  ADD CONSTRAINT check_media_asset_gallery_text_equivalent CHECK (
    (
      asset_type <> 'snapshot_image'
      AND image_content_kind IS NULL
      AND full_text_public IS NULL
    )
    OR (
      asset_type = 'snapshot_image'
      AND (
        (image_content_kind IS NULL AND full_text_public IS NULL)
        OR (
          image_content_kind IS NOT NULL
          AND (
            (image_content_kind = 'ordinary' AND full_text_public IS NULL)
            OR (
              image_content_kind = 'text_bearing'
              AND full_text_public IS NOT NULL
              AND full_text_public = pg_catalog.btrim(full_text_public)
              AND full_text_public <> ''
              AND pg_catalog.length(full_text_public) <= 5000
            )
          )
        )
      )
    )
  );

--------------------------------------------------------------------------------
-- 2. finalize_browser_import_media_stage
--    Forward-redefined from 20260824050000_multi_image_gallery.sql. Adds the declared
--    contentKind/fullText per snapshot to validation, registration and convergence checking.
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
  -- Migration 0057: project-team-declared text-equivalent contract for a snapshot.
  v_content_kind text;
  v_full_text text;
  v_file_size_bytes bigint;

  -- Task 3: deterministic snapshot gallery identity.
  -- NULL for every non-snapshot asset.
  v_gallery_position integer;

  v_project RECORD;
  v_existing_asset RECORD;
  v_registered_count integer := 0;
  v_seen_asset_keys text[] := ARRAY[]::text[];
  v_asset_key text;
BEGIN
  -- -------------------------------------------------------------------------
  -- 1. Top-level parameter validation
  -- -------------------------------------------------------------------------

  v_media_intent_hash :=
    pg_catalog.btrim(COALESCE(p_media_intent_hash, ''));

  v_metadata_intent_hash :=
    pg_catalog.btrim(COALESCE(p_metadata_intent_hash, ''));

  IF
    v_media_intent_hash !~ '^[a-f0-9]{64}$'
    OR v_metadata_intent_hash !~ '^[a-f0-9]{64}$'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_INTENT'
    );
  END IF;

  IF p_batch_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'BATCH_NOT_FOUND'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 2. Transaction lock + idempotency ledger
  -- -------------------------------------------------------------------------

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_batch_id::text)
  );

  SELECT
    c.batch_id,
    c.media_intent_hash,
    c.asset_count
  INTO v_existing_ledger
  FROM public.browser_import_media_commits AS c
  WHERE c.batch_id = p_batch_id;

  IF FOUND THEN
    IF
      v_existing_ledger.media_intent_hash <>
      v_media_intent_hash
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'INTENT_MISMATCH'
      );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'SUCCESS',
      'result', 'already_completed',
      'batchId', p_batch_id,
      'mediaAssetCount', v_existing_ledger.asset_count,
      'batchStatus', 'completed'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 3. Validate acting administrator
  -- -------------------------------------------------------------------------

  IF p_completed_by_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_SELECTION'
    );
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_admin_count
  FROM public.admin_users AS u
  WHERE u.id = p_completed_by_id;

  IF v_admin_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_SELECTION'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 4. Fetch and lock batch
  -- -------------------------------------------------------------------------

  SELECT
    b.id,
    b.status
  INTO v_batch
  FROM public.import_batches AS b
  WHERE b.id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'BATCH_NOT_FOUND'
    );
  END IF;

  IF v_batch.status <> 'metadata_staged' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_BATCH_STATE'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 5. Verify binding to metadata-stage intent
  -- -------------------------------------------------------------------------

  SELECT
    bic.batch_id,
    bic.intent_hash
  INTO v_commit_binding
  FROM public.browser_import_commits AS bic
  WHERE bic.batch_id = p_batch_id;

  IF
    NOT FOUND
    OR v_commit_binding.intent_hash <>
       v_metadata_intent_hash
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INTENT_BINDING_MISMATCH'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- 6. Validate asset array
  --
  -- Max:
  -- 25 packages *
  -- (poster image + poster PDF + 10 gallery images)
  -- = 300 files.
  -- -------------------------------------------------------------------------

  IF
    p_assets IS NULL
    OR pg_catalog.jsonb_typeof(p_assets) <> 'array'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_SELECTION'
    );
  END IF;

  v_asset_count :=
    pg_catalog.jsonb_array_length(p_assets);

  IF
    v_asset_count = 0
    OR v_asset_count > 300
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_SELECTION'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- ALL VALIDATION ABOVE IS NON-MUTATING.
  -- FAILURES AFTER THIS POINT RAISE SO THE TRANSACTION ROLLS BACK.
  ---------------------------------------------------------------------------

  FOR v_asset IN
    SELECT *
    FROM pg_catalog.jsonb_array_elements(p_assets)
  LOOP
    IF pg_catalog.jsonb_typeof(v_asset) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_ASSET_SHAPE';
    END IF;

    v_public_id :=
      pg_catalog.btrim(
        COALESCE(v_asset->>'projectPublicId', '')
      );

    v_package_path :=
      pg_catalog.btrim(
        COALESCE(v_asset->>'packagePath', '')
      );

    v_asset_type :=
      pg_catalog.btrim(
        COALESCE(v_asset->>'assetType', '')
      );

    v_file_name :=
      pg_catalog.btrim(
        COALESCE(v_asset->>'fileName', '')
      );

    v_storage_bucket :=
      pg_catalog.btrim(
        COALESCE(v_asset->>'storageBucket', '')
      );

    v_storage_path :=
      pg_catalog.btrim(
        COALESCE(v_asset->>'storagePath', '')
      );

    v_mime_type :=
      pg_catalog.btrim(
        COALESCE(v_asset->>'mimeType', '')
      );

    IF
      v_public_id = ''
      OR v_package_path = ''
      OR v_file_name = ''
      OR v_storage_bucket = ''
      OR v_storage_path = ''
    THEN
      RAISE EXCEPTION 'INVALID_ASSET_FIELDS';
    END IF;

    IF
      v_asset_type NOT IN (
        'poster_image',
        'poster_pdf',
        'snapshot_image'
      )
    THEN
      RAISE EXCEPTION 'INVALID_ASSET_TYPE';
    END IF;

    -- -----------------------------------------------------------------------
    -- Task 3 gallery position.
    --
    -- snapshot_image:
    --   required integer 1..10
    --
    -- every non-snapshot asset:
    --   must carry no gallery position
    -- -----------------------------------------------------------------------

    v_gallery_position := NULL;

    IF v_asset_type = 'snapshot_image' THEN
      IF
        NOT (v_asset ? 'galleryPosition')
        OR pg_catalog.jsonb_typeof(
          v_asset->'galleryPosition'
        ) <> 'number'
        OR (v_asset->>'galleryPosition')
           !~ '^([1-9]|10)$'
      THEN
        RAISE EXCEPTION 'INVALID_GALLERY_POSITION';
      END IF;

      v_gallery_position :=
        (v_asset->>'galleryPosition')::integer;

    ELSE
      IF
        v_asset ? 'galleryPosition'
        AND pg_catalog.jsonb_typeof(
          v_asset->'galleryPosition'
        ) <> 'null'
      THEN
        RAISE EXCEPTION 'INVALID_GALLERY_POSITION';
      END IF;
    END IF;

    -- -----------------------------------------------------------------------
    -- Authoritative snapshot alt text.
    -- -----------------------------------------------------------------------

    v_alt_text :=
      NULLIF(
        pg_catalog.btrim(
          COALESCE(v_asset->>'snapshotAltText', '')
        ),
        ''
      );

    IF v_alt_text IS NOT NULL THEN
      IF v_asset_type <> 'snapshot_image' THEN
        RAISE EXCEPTION 'INVALID_ASSET_ALT_TEXT';
      END IF;

      IF pg_catalog.length(v_alt_text) > 2000 THEN
        RAISE EXCEPTION 'INVALID_ASSET_ALT_TEXT';
      END IF;
    END IF;

    -- -----------------------------------------------------------------------
    -- Text-equivalent declaration (Migration 0057).
    --
    -- Both values come from the server-reparsed package manifest, exactly
    -- like the alt text, and are bound into the media intent hash with it.
    -- A snapshot may arrive undeclared (legacy project.json); it is then
    -- registered with NULLs and held by every later workflow gate. A value
    -- that is present must be coherent: a declared kind, a bounded full text
    -- exactly for text_bearing, and nothing on a non-snapshot asset.
    -- -----------------------------------------------------------------------

    v_content_kind :=
      NULLIF(
        pg_catalog.btrim(
          COALESCE(v_asset->>'snapshotContentKind', '')
        ),
        ''
      );

    v_full_text :=
      NULLIF(
        pg_catalog.btrim(
          COALESCE(v_asset->>'snapshotFullText', '')
        ),
        ''
      );

    IF v_asset_type <> 'snapshot_image' THEN
      IF v_content_kind IS NOT NULL OR v_full_text IS NOT NULL THEN
        RAISE EXCEPTION 'INVALID_ASSET_TEXT_EQUIVALENT';
      END IF;
    ELSE
      IF v_content_kind IS NOT NULL
         AND v_content_kind NOT IN ('ordinary', 'text_bearing') THEN
        RAISE EXCEPTION 'INVALID_ASSET_TEXT_EQUIVALENT';
      END IF;

      IF v_full_text IS NOT NULL
         AND pg_catalog.length(v_full_text) > 5000 THEN
        RAISE EXCEPTION 'INVALID_ASSET_TEXT_EQUIVALENT';
      END IF;

      IF (v_content_kind = 'text_bearing' AND v_full_text IS NULL)
         OR (v_content_kind IS DISTINCT FROM 'text_bearing' AND v_full_text IS NOT NULL) THEN
        RAISE EXCEPTION 'INVALID_ASSET_TEXT_EQUIVALENT';
      END IF;
    END IF;

    -- -----------------------------------------------------------------------
    -- File size
    -- -----------------------------------------------------------------------

    IF
      NOT (v_asset ? 'fileSizeBytes')
      OR pg_catalog.jsonb_typeof(
        v_asset->'fileSizeBytes'
      ) <> 'number'
    THEN
      RAISE EXCEPTION 'INVALID_ASSET_SIZE';
    END IF;

    v_file_size_bytes :=
      (v_asset->>'fileSizeBytes')::bigint;

    IF v_file_size_bytes <= 0 THEN
      RAISE EXCEPTION 'INVALID_ASSET_SIZE';
    END IF;

    -- -----------------------------------------------------------------------
    -- Reject duplicate identities inside this request.
    --
    -- Fixed media identity:
    --   publicId::assetType
    --
    -- Snapshot identity:
    --   publicId::snapshot_image::position
    -- -----------------------------------------------------------------------

    IF v_asset_type = 'snapshot_image' THEN
      v_asset_key :=
        v_public_id
        || '::snapshot_image::'
        || v_gallery_position::text;
    ELSE
      v_asset_key :=
        v_public_id
        || '::'
        || v_asset_type;
    END IF;

    IF v_asset_key = ANY(v_seen_asset_keys) THEN
      RAISE EXCEPTION 'DUPLICATE_ASSET_IN_REQUEST';
    END IF;

    v_seen_asset_keys :=
      pg_catalog.array_append(
        v_seen_asset_keys,
        v_asset_key
      );

    -- -----------------------------------------------------------------------
    -- Resolve project and enforce same-batch ownership.
    -- -----------------------------------------------------------------------

    SELECT p.id
    INTO v_project
    FROM public.projects AS p
    WHERE p.public_id = v_public_id
      AND p.import_batch_id = p_batch_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_NOT_IN_BATCH';
    END IF;

    -- -----------------------------------------------------------------------
    -- Register media asset.
    --
    -- Generic ON CONFLICT is intentional:
    --   fixed media use project+asset_type partial uniqueness;
    --   snapshot media use project+gallery_position partial uniqueness;
    --   storage bucket/path also remains unique.
    --
    -- Existing rows are never overwritten.
    -- -----------------------------------------------------------------------

    INSERT INTO public.media_assets (
      project_id,
      asset_type,
      gallery_position,
      file_name,
      storage_bucket,
      storage_path,
      public_url,
      mime_type,
      file_size_bytes,
      is_public_approved,
      alt_text_public,
      image_content_kind,
      full_text_public
    )
    VALUES (
      v_project.id,
      v_asset_type,
      v_gallery_position,
      v_file_name,
      v_storage_bucket,
      v_storage_path,
      NULL,
      NULLIF(v_mime_type, ''),
      v_file_size_bytes,
      false,
      v_alt_text,
      v_content_kind,
      v_full_text
    )
    ON CONFLICT DO NOTHING;

    -- -----------------------------------------------------------------------
    -- Verify convergence after an idempotent insert/no-op.
    --
    -- Snapshot rows are identified by project + gallery position.
    -- Other assets retain project + asset type identity.
    -- -----------------------------------------------------------------------

    IF v_asset_type = 'snapshot_image' THEN
      SELECT
        ma.storage_bucket,
        ma.storage_path,
        ma.alt_text_public,
        ma.gallery_position,
        ma.image_content_kind,
        ma.full_text_public
      INTO v_existing_asset
      FROM public.media_assets AS ma
      WHERE ma.project_id = v_project.id
        AND ma.asset_type = 'snapshot_image'
        AND ma.gallery_position =
            v_gallery_position;
    ELSE
      SELECT
        ma.storage_bucket,
        ma.storage_path,
        ma.alt_text_public,
        ma.gallery_position,
        ma.image_content_kind,
        ma.full_text_public
      INTO v_existing_asset
      FROM public.media_assets AS ma
      WHERE ma.project_id = v_project.id
        AND ma.asset_type = v_asset_type
        AND ma.gallery_position IS NULL;
    END IF;

    IF
      NOT FOUND
      OR v_existing_asset.storage_bucket <>
         v_storage_bucket
      OR v_existing_asset.storage_path <>
         v_storage_path
      OR v_existing_asset.alt_text_public
         IS DISTINCT FROM v_alt_text
      OR v_existing_asset.gallery_position
         IS DISTINCT FROM v_gallery_position
      -- A retry that changes the declaration or the full text is a divergent
      -- intent, never a convergent no-op.
      OR v_existing_asset.image_content_kind
         IS DISTINCT FROM v_content_kind
      OR v_existing_asset.full_text_public
         IS DISTINCT FROM v_full_text
    THEN
      RAISE EXCEPTION 'MEDIA_ASSET_CONFLICT';
    END IF;

    v_registered_count :=
      v_registered_count + 1;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 7. Create idempotency ledger
  -- -------------------------------------------------------------------------

  INSERT INTO public.browser_import_media_commits (
    batch_id,
    media_intent_hash,
    metadata_intent_hash,
    asset_count,
    completed_by
  )
  VALUES (
    p_batch_id,
    v_media_intent_hash,
    v_metadata_intent_hash,
    v_registered_count,
    p_completed_by_id
  );

  -- -------------------------------------------------------------------------
  -- 8. Complete batch. Projects intentionally remain draft.
  -- -------------------------------------------------------------------------

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
REVOKE EXECUTE ON FUNCTION
  public.finalize_browser_import_media_stage(
    uuid,
    text,
    text,
    uuid,
    jsonb
  )
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  public.finalize_browser_import_media_stage(
    uuid,
    text,
    text,
    uuid,
    jsonb
  )
FROM anon;

REVOKE EXECUTE ON FUNCTION
  public.finalize_browser_import_media_stage(
    uuid,
    text,
    text,
    uuid,
    jsonb
  )
FROM authenticated;

GRANT EXECUTE ON FUNCTION
  public.finalize_browser_import_media_stage(
    uuid,
    text,
    text,
    uuid,
    jsonb
  )
TO service_role;

--------------------------------------------------------------------------------
-- 3. submit_import_projects_for_review
--    Forward-redefined from 20260825025000_multi_image_gallery_review_submission.sql. Adds the
--    MISSING_SNAPSHOT_CONTENT_TYPE / MISSING_SNAPSHOT_FULL_TEXT / SNAPSHOT_FULL_TEXT_TOO_LONG /
--    UNEXPECTED_SNAPSHOT_FULL_TEXT readiness blockers.
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
  v_snapshot_count integer;
  v_valid_snapshot_count integer;
  v_distinct_snapshot_positions integer;
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

    -- Structural gallery validation. Review submission is the authoritative
    -- server-side gate, so it must prove every snapshot is a valid staged
    -- gallery element before any status mutation -- not merely that alt text
    -- is present. gallery_position, not asset_type, is snapshot identity, so a
    -- NULL/out-of-range/duplicate position is a structural defect even when the
    -- underlying file is otherwise well-formed.
    SELECT
      pg_catalog.count(*),
      pg_catalog.count(*) FILTER (
        WHERE ma.storage_bucket = 'project-drafts-private'
          AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
          AND pg_catalog.left(
                ma.storage_path,
                pg_catalog.length('drafts/' || v_project.public_id || '/snapshot_image/')
              ) = 'drafts/' || v_project.public_id || '/snapshot_image/'
          AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
          AND pg_catalog.strpos(ma.storage_path, '..') = 0
          AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
          AND ma.file_name = pg_catalog.btrim(ma.file_name)
          AND ma.file_name <> ''
          AND pg_catalog.strpos(ma.file_name, '..') = 0
          AND pg_catalog.strpos(ma.file_name, '/') = 0
          AND pg_catalog.strpos(ma.file_name, E'\\') = 0
          AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
          AND ma.file_size_bytes BETWEEN 1 AND 5242880
          AND ma.is_public_approved = false
          AND ma.public_url IS NULL
          AND ma.public_storage_bucket IS NULL
          AND ma.public_storage_path IS NULL
          AND ma.gallery_position BETWEEN 1 AND 10
      ),
      pg_catalog.count(DISTINCT ma.gallery_position)
      INTO v_snapshot_count, v_valid_snapshot_count, v_distinct_snapshot_positions
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id
       AND ma.asset_type = 'snapshot_image';

    -- Zero snapshots remains valid; a populated gallery must be wholly valid.
    IF v_snapshot_count > 0
       AND (
         v_snapshot_count > 10
         OR v_valid_snapshot_count <> v_snapshot_count
         OR v_distinct_snapshot_positions <> v_snapshot_count
       ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'INVALID_SNAPSHOT_GALLERY_STRUCTURE'
      );
    END IF;

    -- Snapshot gallery accessibility is conditional by design.
    -- Zero snapshots remains valid. When snapshots exist, every snapshot row is
    -- checked server-side; no single-row selection may hide an invalid gallery item.
    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'MISSING_SNAPSHOT_ALT_TEXT'
      );
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND pg_catalog.length(
               pg_catalog.btrim(COALESCE(ma.alt_text_public, ''))
             ) > 2000
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'SNAPSHOT_ALT_TEXT_TOO_LONG'
      );
    END IF;

    -- Text-equivalent contract (Migration 0057). Every snapshot must be
    -- explicitly declared ordinary or text-bearing, and a text-bearing image
    -- must carry a bounded full text. An undeclared legacy row blocks here
    -- rather than passing as an ordinary photograph; the remedy is a corrected
    -- project-team package, never a staff edit.
    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND ma.image_content_kind IS NULL
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'MISSING_SNAPSHOT_CONTENT_TYPE'
      );
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND ma.image_content_kind = 'text_bearing'
         AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) = ''
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'MISSING_SNAPSHOT_FULL_TEXT'
      );
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND pg_catalog.length(
               pg_catalog.btrim(COALESCE(ma.full_text_public, ''))
             ) > 5000
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'SNAPSHOT_FULL_TEXT_TOO_LONG'
      );
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND ma.image_content_kind IS DISTINCT FROM 'text_bearing'
         AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) <> ''
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'UNEXPECTED_SNAPSHOT_FULL_TEXT'
      );
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
-- 4. perform_project_review_action
--    Forward-redefined from 20260824060000_multi_image_gallery_approval_gate.sql. The approve
--    branch additionally requires every snapshot to be declared and every text-bearing snapshot
--    to carry its full text (MEDIA_ACCESSIBILITY_REQUIRED / MEDIA_ACCESSIBILITY_INVALID).
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.perform_project_review_action(p_public_id text, p_action text, p_comments text, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text; v_comments text; v_roles text[]; v_project_id uuid; v_from_status text;
  v_to_status text; v_archive_reason text; v_now timestamptz; v_audit_record_id uuid;
  v_unresolved integer; v_active integer;
  v_poster_text text; v_accessibility_text text;
  v_media_count integer;
  v_valid_media_count integer;
  v_distinct_gallery_positions integer;
  v_missing_snapshot_alt_count integer;
  v_invalid_snapshot_alt_count integer;
  -- Migration 0057: text-equivalent contract counters.
  v_undeclared_snapshot_count integer;
  v_missing_snapshot_full_text_count integer;
  v_invalid_snapshot_full_text_count integer;
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
  IF p_action = 'approve' THEN
    IF pg_catalog.btrim(COALESCE(v_poster_text, '')) = ''
       OR pg_catalog.btrim(COALESCE(v_accessibility_text, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED');
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(v_poster_text)) > 20000
       OR pg_catalog.length(pg_catalog.btrim(v_accessibility_text)) > 2000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_INVALID');
    END IF;

    -- Stabilize this project's current media rows before deriving authority. The locked project row
    -- also prevents a concurrent new child row from completing its foreign-key check until this
    -- transaction ends, so the checks and status mutation observe one coherent project/media state.
    PERFORM ma.id FROM public.media_assets ma
     WHERE ma.project_id = v_project_id
     ORDER BY ma.id
     FOR UPDATE;

    SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE
      ma.storage_bucket = 'project-drafts-private'
      AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
      AND pg_catalog.left(ma.storage_path, pg_catalog.length('drafts/' || v_public_id || '/poster_image/')) = 'drafts/' || v_public_id || '/poster_image/'
      AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
      AND pg_catalog.strpos(ma.storage_path, '..') = 0 AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
      AND ma.file_name = pg_catalog.btrim(ma.file_name) AND ma.file_name <> ''
      AND pg_catalog.strpos(ma.file_name, '..') = 0 AND pg_catalog.strpos(ma.file_name, '/') = 0 AND pg_catalog.strpos(ma.file_name, E'\\') = 0
      AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
      AND ma.file_size_bytes BETWEEN 1 AND 5242880
      AND ma.is_public_approved = false AND ma.public_url IS NULL
      AND ma.public_storage_bucket IS NULL AND ma.public_storage_path IS NULL
    ) INTO v_media_count, v_valid_media_count
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id AND ma.asset_type = 'poster_image';
    IF v_media_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_REQUIRED', 'assetType', 'poster_image');
    END IF;
    IF v_media_count <> 1 OR v_valid_media_count <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_INVALID', 'assetType', 'poster_image');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE
      ma.storage_bucket = 'project-drafts-private'
      AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
      AND pg_catalog.left(ma.storage_path, pg_catalog.length('drafts/' || v_public_id || '/poster_pdf/')) = 'drafts/' || v_public_id || '/poster_pdf/'
      AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
      AND pg_catalog.strpos(ma.storage_path, '..') = 0 AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
      AND ma.file_name = pg_catalog.btrim(ma.file_name) AND ma.file_name <> ''
      AND pg_catalog.strpos(ma.file_name, '..') = 0 AND pg_catalog.strpos(ma.file_name, '/') = 0 AND pg_catalog.strpos(ma.file_name, E'\\') = 0
      AND ma.mime_type = 'application/pdf'
      AND ma.file_size_bytes BETWEEN 1 AND 20971520
      AND ma.is_public_approved = false AND ma.public_url IS NULL
      AND ma.public_storage_bucket IS NULL AND ma.public_storage_path IS NULL
    ) INTO v_media_count, v_valid_media_count
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id AND ma.asset_type = 'poster_pdf';
    IF v_media_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_REQUIRED', 'assetType', 'poster_pdf');
    END IF;
    IF v_media_count <> 1 OR v_valid_media_count <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_INVALID', 'assetType', 'poster_pdf');
    END IF;

    SELECT
        pg_catalog.count(*),

        pg_catalog.count(*) FILTER (
            WHERE
            ma.storage_bucket = 'project-drafts-private'
            AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
            AND pg_catalog.left(
                ma.storage_path,
                pg_catalog.length('drafts/' || v_public_id || '/snapshot_image/')
            ) = 'drafts/' || v_public_id || '/snapshot_image/'
            AND pg_catalog.right(
                ma.storage_path,
                pg_catalog.length(ma.file_name)
            ) = ma.file_name
            AND pg_catalog.strpos(ma.storage_path, '..') = 0
            AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
            AND ma.file_name = pg_catalog.btrim(ma.file_name)
            AND ma.file_name <> ''
            AND pg_catalog.strpos(ma.file_name, '..') = 0
            AND pg_catalog.strpos(ma.file_name, '/') = 0
            AND pg_catalog.strpos(ma.file_name, E'\\') = 0
            AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
            AND ma.file_size_bytes BETWEEN 1 AND 5242880
            AND ma.is_public_approved = false
            AND ma.public_url IS NULL
            AND ma.public_storage_bucket IS NULL
            AND ma.public_storage_path IS NULL
            AND ma.gallery_position BETWEEN 1 AND 10
        ),

        pg_catalog.count(DISTINCT ma.gallery_position),

        pg_catalog.count(*) FILTER (
            WHERE pg_catalog.btrim(
            COALESCE(ma.alt_text_public, '')
            ) = ''
        ),

        pg_catalog.count(*) FILTER (
            WHERE ma.alt_text_public IS NOT NULL
            AND pg_catalog.length(
                pg_catalog.btrim(ma.alt_text_public)
            ) > 2000
        ),

        -- Undeclared: neither ordinary nor text-bearing has been stated.
        pg_catalog.count(*) FILTER (
            WHERE ma.image_content_kind IS NULL
        ),

        -- Text-bearing without its full textual equivalent.
        pg_catalog.count(*) FILTER (
            WHERE ma.image_content_kind = 'text_bearing'
            AND pg_catalog.btrim(
                COALESCE(ma.full_text_public, '')
            ) = ''
        ),

        -- Oversized full text, or a full text on an image declared ordinary.
        pg_catalog.count(*) FILTER (
            WHERE (
                ma.full_text_public IS NOT NULL
                AND pg_catalog.length(
                    pg_catalog.btrim(ma.full_text_public)
                ) > 5000
            )
            OR (
                ma.image_content_kind IS DISTINCT FROM 'text_bearing'
                AND pg_catalog.btrim(
                    COALESCE(ma.full_text_public, '')
                ) <> ''
            )
        )

        INTO
        v_media_count,
        v_valid_media_count,
        v_distinct_gallery_positions,
        v_missing_snapshot_alt_count,
        v_invalid_snapshot_alt_count,
        v_undeclared_snapshot_count,
        v_missing_snapshot_full_text_count,
        v_invalid_snapshot_full_text_count

        FROM public.media_assets ma
        WHERE ma.project_id = v_project_id
        AND ma.asset_type = 'snapshot_image';

        -- Snapshot gallery remains optional.
        IF v_media_count > 0 THEN

        -- Every snapshot must be valid private media and must carry a unique,
        -- authoritative position in the bounded gallery.
        IF v_media_count > 10
            OR v_valid_media_count <> v_media_count
            OR v_distinct_gallery_positions <> v_media_count THEN

            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'PROJECT_MEDIA_INVALID',
            'assetType',
            'snapshot_image'
            );
        END IF;

        -- Every gallery image requires its own authoritative alt text.
        IF v_missing_snapshot_alt_count > 0 THEN
            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'MEDIA_ACCESSIBILITY_REQUIRED'
            );
        END IF;

        IF v_invalid_snapshot_alt_count > 0 THEN
            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'MEDIA_ACCESSIBILITY_INVALID'
            );
        END IF;

        -- Migration 0057: every gallery image requires an explicit
        -- project-team classification, and a text-bearing image requires its
        -- full textual equivalent, before approval. Nothing is inferred.
        IF v_undeclared_snapshot_count > 0
            OR v_missing_snapshot_full_text_count > 0 THEN
            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'MEDIA_ACCESSIBILITY_REQUIRED'
            );
        END IF;

        IF v_invalid_snapshot_full_text_count > 0 THEN
            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'MEDIA_ACCESSIBILITY_INVALID'
            );
        END IF;

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
-- 5. generate_participant_preview (6-arg implementation)
--    Forward-redefined from 20260903120000_participant_preview_controlled_links.sql. Adds the
--    text-equivalent issuance gate and captures contentKind/fullText on snapshot elements of the
--    immutable media snapshot.
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
  v_media_total_count integer;
  v_media_valid_count integer;
  v_poster_image_count integer;
  v_poster_pdf_count integer;
  v_snapshot_total_count integer;
  v_snapshot_position_count integer;
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
  -- 6b. Task 3 authoritative media state gate.
  --
  -- The immutable preview is the participant's evidence of exactly which
  -- gallery they were asked to confirm, so it must be derived from the
  -- COMPLETE validated media set -- never from rows pre-filtered to those
  -- that already look private. Filtering first would let an anomalous row
  -- (wrong bucket, unexpectedly public, malformed identity, duplicate or
  -- out-of-range position) be silently omitted from immutable evidence
  -- instead of blocking issuance. Every project media row is therefore
  -- locked and validated here, and any contradiction fails closed.
  ---------------------------------------------------------------------------

  PERFORM 1
     FROM public.media_assets ma
    WHERE ma.project_id = v_project_id
      FOR UPDATE;

  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE ma.asset_type IN ('poster_image', 'poster_pdf', 'snapshot_image')
        AND ma.storage_bucket = v_private_bucket
        AND ma.is_public_approved = false
        AND ma.public_url IS NULL
        AND ma.public_storage_bucket IS NULL
        AND ma.public_storage_path IS NULL
        AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
        AND ma.storage_path <> ''
        AND pg_catalog.strpos(ma.storage_path, '..') = 0
        AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
        AND ma.file_name = pg_catalog.btrim(ma.file_name)
        AND ma.file_name <> ''
        AND pg_catalog.strpos(ma.file_name, '..') = 0
        AND pg_catalog.strpos(ma.file_name, '/') = 0
        AND pg_catalog.strpos(ma.file_name, E'\\') = 0
        AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
        AND pg_catalog.left(
              ma.storage_path,
              pg_catalog.length('drafts/' || v_public_id || '/' || ma.asset_type || '/')
            ) = 'drafts/' || v_public_id || '/' || ma.asset_type || '/'
        AND ma.file_size_bytes IS NOT NULL
        AND ma.file_size_bytes >= 1
        AND (
          CASE ma.asset_type
            WHEN 'poster_pdf' THEN
              ma.mime_type = 'application/pdf'
              AND ma.file_size_bytes <= 20971520
              AND ma.gallery_position IS NULL
            WHEN 'poster_image' THEN
              ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
              AND ma.file_size_bytes <= 5242880
              AND ma.gallery_position IS NULL
            ELSE
              ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
              AND ma.file_size_bytes <= 5242880
              AND ma.gallery_position BETWEEN 1 AND 10
          END
        )
    ),
    pg_catalog.count(*) FILTER (WHERE ma.asset_type = 'poster_image'),
    pg_catalog.count(*) FILTER (WHERE ma.asset_type = 'poster_pdf'),
    pg_catalog.count(*) FILTER (WHERE ma.asset_type = 'snapshot_image'),
    pg_catalog.count(DISTINCT ma.gallery_position)
      FILTER (WHERE ma.asset_type = 'snapshot_image')
  INTO
    v_media_total_count,
    v_media_valid_count,
    v_poster_image_count,
    v_poster_pdf_count,
    v_snapshot_total_count,
    v_snapshot_position_count
  FROM public.media_assets ma
  WHERE ma.project_id = v_project_id;

  -- Poster assets are singletons; the gallery is bounded at 10 and every
  -- member must hold a distinct position. Position, not asset type, is
  -- snapshot identity, so a duplicate or absent position is a hard defect.
  IF v_media_valid_count <> v_media_total_count
     OR v_poster_image_count > 1
     OR v_poster_pdf_count > 1
     OR v_snapshot_total_count > 10
     OR v_snapshot_position_count <> v_snapshot_total_count THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_MEDIA_INVALID'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 6c. Task 3 multi-image accessibility gate.
  --
  -- Every snapshot in the now-validated gallery must carry usable
  -- authoritative alt text. No private-only prefilter here: the gate above
  -- already proved the complete set is private and well-formed.
  ---------------------------------------------------------------------------

  IF EXISTS (
    SELECT 1
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id
       AND ma.asset_type = 'snapshot_image'
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
  -- 6d. Text-equivalent gate (Migration 0057).
  --
  -- The preview freezes exactly what would be published, so every snapshot
  -- must already be explicitly declared ordinary or text-bearing, and a
  -- text-bearing image must carry a bounded full text. An undeclared legacy
  -- row cannot be previewed as an ordinary photograph.
  ---------------------------------------------------------------------------

  IF EXISTS (
    SELECT 1
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id
       AND ma.asset_type = 'snapshot_image'
       AND (
         ma.image_content_kind IS NULL
         OR ma.image_content_kind NOT IN ('ordinary', 'text_bearing')
         OR (
           ma.image_content_kind = 'text_bearing'
           AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) = ''
         )
         OR (
           ma.image_content_kind <> 'text_bearing'
           AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) <> ''
         )
         OR pg_catalog.length(
           pg_catalog.btrim(COALESCE(ma.full_text_public, ''))
         ) > 5000
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
      'videoUrl', p.video_url,
      'demoUrl', p.demo_url,
      'repositoryUrl', p.repository_url,
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
  --
  -- Migration 0057: a snapshot_image element additionally carries the
  -- declared contentKind and its fullText (null for an ordinary image), so
  -- the participant confirms the exact text equivalent that will be
  -- published and any later change to either value makes the confirmation
  -- stale. Poster/PDF elements deliberately carry neither key, so a preview
  -- issued before this migration for a project with no gallery keeps its
  -- exact historical media shape and stays comparable.
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
      || CASE
           WHEN ma.asset_type = 'snapshot_image'
             THEN pg_catalog.jsonb_build_object(
               'contentKind', ma.image_content_kind,
               'fullText', ma.full_text_public
             )
           ELSE '{}'::jsonb
         END
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
  -- No private-only prefilter: gate 6b already proved every row for this
  -- project is valid private staged media, so the evidence captured here is
  -- the complete expected set rather than whatever happened to conform.
  WHERE ma.project_id = v_project_id;

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
REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text, boolean)
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text, boolean)
FROM anon;
REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text, boolean)
FROM authenticated;
GRANT EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text, boolean)
TO service_role;

-- The 5-argument wrapper delegates to the implementation above. Re-assert its privileges so the
-- legacy callable path cannot bypass the gate.
REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text)
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text)
FROM anon;
REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text)
FROM authenticated;
GRANT EXECUTE ON FUNCTION
  public.generate_participant_preview(text, uuid, text, integer, text)
TO service_role;

--------------------------------------------------------------------------------
-- 6. get_project_publication_readiness
--    Forward-redefined from 20260903120000_participant_preview_controlled_links.sql. Evaluates the
--    text-equivalent contract against the CURRENT rows, carries contentKind/fullText in the
--    re-derived media snapshot, and validates those keys on stored evidence.
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
  v_snapshot_total_count integer;
  v_snapshot_valid_count integer;
  v_snapshot_position_count integer;
  v_snapshot_missing_alt_count integer;
  v_snapshot_long_alt_count integer;
  -- Migration 0057: text-equivalent contract counters.
  v_snapshot_undeclared_count integer;
  v_snapshot_missing_full_text_count integer;
  v_snapshot_long_full_text_count integer;
  v_snapshot_unexpected_full_text_count integer;
  v_current_snapshot jsonb;
  v_comparable_snapshot jsonb;
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

  -- 4c. Snapshot gallery accessibility and structural validity, evaluated against the CURRENT
  -- media rows for the same reason as 4b: a snapshot whose alt was already absent when the preview
  -- was issued would otherwise match its own stored snapshot and pass unnoticed. Every current
  -- gallery row is inspected -- never an arbitrary first row of a multi-row gallery -- and no
  -- private-only prefilter is applied, so a contradictory row fails closed here instead of being
  -- silently skipped by the filter that was meant to find it.
  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE ma.storage_bucket = v_private_bucket
        AND ma.is_public_approved = false
        AND ma.public_url IS NULL
        AND ma.public_storage_bucket IS NULL
        AND ma.public_storage_path IS NULL
        AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
        AND pg_catalog.strpos(ma.storage_path, '..') = 0
        AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
        AND ma.file_name = pg_catalog.btrim(ma.file_name)
        AND ma.file_name <> ''
        AND pg_catalog.strpos(ma.file_name, '..') = 0
        AND pg_catalog.strpos(ma.file_name, '/') = 0
        AND pg_catalog.strpos(ma.file_name, E'\\') = 0
        AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
        AND pg_catalog.left(
              ma.storage_path,
              pg_catalog.length('drafts/' || v_project.public_id || '/snapshot_image/')
            ) = 'drafts/' || v_project.public_id || '/snapshot_image/'
        AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
        AND ma.file_size_bytes BETWEEN 1 AND 5242880
        AND ma.gallery_position BETWEEN 1 AND 10
    ),
    pg_catalog.count(DISTINCT ma.gallery_position),
    pg_catalog.count(*) FILTER (
      WHERE pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.alt_text_public IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(ma.alt_text_public)) > 2000
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.image_content_kind IS NULL
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.image_content_kind = 'text_bearing'
        AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) = ''
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.full_text_public IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(ma.full_text_public)) > 5000
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.image_content_kind IS DISTINCT FROM 'text_bearing'
        AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) <> ''
    )
    INTO
      v_snapshot_total_count,
      v_snapshot_valid_count,
      v_snapshot_position_count,
      v_snapshot_missing_alt_count,
      v_snapshot_long_alt_count,
      v_snapshot_undeclared_count,
      v_snapshot_missing_full_text_count,
      v_snapshot_long_full_text_count,
      v_snapshot_unexpected_full_text_count
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.asset_type = 'snapshot_image';

  -- A zero-snapshot gallery stays publishable. A populated one must be wholly
  -- valid: bounded at 10, every member privately staged and well-formed, and
  -- every member holding a distinct position. Position, not asset type, is
  -- snapshot identity.
  IF v_snapshot_total_count > 0 THEN
    IF v_snapshot_total_count > 10
       OR v_snapshot_valid_count <> v_snapshot_total_count
       OR v_snapshot_position_count <> v_snapshot_total_count THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot gallery media state is invalid'
      );
    END IF;

    IF v_snapshot_missing_alt_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s alt text is missing', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_long_alt_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s alt text exceeds the 2,000 character safety limit', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND pg_catalog.length(pg_catalog.btrim(ma.alt_text_public)) > 2000
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    -- Migration 0057: the text-equivalent contract is evaluated against the CURRENT rows for
    -- the same reason as the alt text. An undeclared legacy row is a blocker, never an
    -- ordinary photograph; the remedy is a corrected project-team package.
    IF v_snapshot_undeclared_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s content type is missing', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.image_content_kind IS NULL
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_missing_full_text_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s full text is missing', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.image_content_kind = 'text_bearing'
           AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) = ''
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_long_full_text_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s full text exceeds the 5,000 character safety limit', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.full_text_public IS NOT NULL
           AND pg_catalog.length(pg_catalog.btrim(ma.full_text_public)) > 5000
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_unexpected_full_text_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s is declared ordinary but carries a full text', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.image_content_kind IS DISTINCT FROM 'text_bearing'
           AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) <> ''
         ORDER BY ma.gallery_position, ma.id
      );
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
      'videoUrl', p.video_url,
      'demoUrl', p.demo_url,
      'repositoryUrl', p.repository_url,
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
  -- Historical-snapshot compatibility for controlled project links.
  --
  -- Previews issued before controlled project links became participant evidence carry none
  -- of the three keys. Such a preview stays equivalent ONLY while the project still has no
  -- controlled link at all. Any populated controlled URL is public-eligible content the
  -- participant was never shown, so it invalidates the confirmation rather than being
  -- grandfathered. Stored snapshots are never rewritten or backfilled to reach this result.
  v_comparable_snapshot := v_current_snapshot;

  IF NOT (v_active_preview.snapshot ? 'videoUrl')
     AND NOT (v_active_preview.snapshot ? 'demoUrl')
     AND NOT (v_active_preview.snapshot ? 'repositoryUrl')
     AND v_current_snapshot->>'videoUrl' IS NULL
     AND v_current_snapshot->>'demoUrl' IS NULL
     AND v_current_snapshot->>'repositoryUrl' IS NULL
  THEN
    v_comparable_snapshot := v_comparable_snapshot - 'videoUrl' - 'demoUrl' - 'repositoryUrl';
  END IF;

  IF v_comparable_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project information changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 10. Re-derive the current canonical private media snapshot.
  --
  -- galleryPosition is now part of the immutable participant-confirmed evidence.
  -- This makes add/remove/replace/reorder operations visible to the stale-media
  -- comparison instead of treating gallery order as mutable display metadata.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mediaAssetId', ma.id,
        'assetType', ma.asset_type,
        'galleryPosition',
          CASE
            WHEN ma.asset_type = 'snapshot_image'
              THEN ma.gallery_position
            ELSE NULL
          END,
        'fileName', ma.file_name,
        'storageBucket', ma.storage_bucket,
        'storagePath', ma.storage_path,
        'mimeType', ma.mime_type,
        'altText', ma.alt_text_public
      )
      -- Migration 0057: snapshot elements carry the declared text equivalent; poster/PDF
      -- elements keep their exact historical shape (see generate_participant_preview).
      || CASE
           WHEN ma.asset_type = 'snapshot_image'
             THEN pg_catalog.jsonb_build_object(
               'contentKind', ma.image_content_kind,
               'fullText', ma.full_text_public
             )
           ELSE '{}'::jsonb
         END
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
  INTO v_current_media_snapshot
  FROM public.media_assets ma
  WHERE ma.project_id = v_project.id
    AND ma.storage_bucket = v_private_bucket
    AND ma.is_public_approved = false
    AND ma.public_url IS NULL;

  -- Canonicalization remains identity-based. Gallery order itself is carried
  -- explicitly by galleryPosition, so changing a snapshot's position changes
  -- the compared immutable object.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
  INTO v_canonical_current_media
  FROM pg_catalog.jsonb_array_elements(
    v_current_media_snapshot
  ) elem;

  v_stored_media_snapshot :=
    COALESCE(
      v_active_preview.media_snapshot,
      '[]'::jsonb
    );

  -- Every stored media element must use the current immutable contract.
  --
  -- snapshot_image:
  --   galleryPosition = integer 1..10
  --   altText         = usable string
  --
  -- other media:
  --   galleryPosition = JSON null
  --   altText         = JSON null
  SELECT pg_catalog.count(*)
    INTO v_invalid_media_element_count
    FROM pg_catalog.jsonb_array_elements(
      v_stored_media_snapshot
    ) elem
   WHERE
      pg_catalog.jsonb_typeof(elem) <> 'object'

      OR pg_catalog.jsonb_typeof(
           elem->'mediaAssetId'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'assetType'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'fileName'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'storageBucket'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'storagePath'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'mimeType'
         ) <> 'string'

      OR NOT (elem ? 'galleryPosition')

      OR NOT (elem ? 'altText')

      OR (
        elem->>'assetType' = 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(
            elem->'galleryPosition'
          ) <> 'number'

          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(
                elem->'galleryPosition'
              ) = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric
                <> pg_catalog.trunc(
                     (elem->>'galleryPosition')::numeric
                   )
              )
              ELSE false
            END
          )

          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(
                elem->'galleryPosition'
              ) = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric < 1
                OR
                (elem->>'galleryPosition')::numeric > 10
              )
              ELSE false
            END
          )

          OR pg_catalog.jsonb_typeof(
               elem->'altText'
             ) <> 'string'

          OR pg_catalog.btrim(
               COALESCE(
                 elem->>'altText',
                 ''
               )
             ) = ''

          OR pg_catalog.length(
               pg_catalog.btrim(
                 elem->>'altText'
               )
             ) > 2000
        )
      )

      OR (
        elem->>'assetType' <> 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(
            elem->'galleryPosition'
          ) <> 'null'

          OR pg_catalog.jsonb_typeof(
               elem->'altText'
             ) <> 'null'

          -- Migration 0057: the text-equivalent keys belong only to snapshot elements.
          OR (elem ? 'contentKind')
          OR (elem ? 'fullText')
        )
      )

      -- Migration 0057: a stored snapshot element either predates the text-equivalent
      -- contract (neither key; such evidence is then reported stale against the current
      -- rows below rather than rewritten) or carries a coherent declaration.
      OR (
        elem->>'assetType' = 'snapshot_image'
        AND (
          (elem ? 'contentKind') <> (elem ? 'fullText')

          OR (
            (elem ? 'contentKind')
            AND (
              pg_catalog.jsonb_typeof(elem->'contentKind') <> 'string'
              OR elem->>'contentKind' NOT IN ('ordinary', 'text_bearing')
              OR (
                elem->>'contentKind' = 'text_bearing'
                AND (
                  pg_catalog.jsonb_typeof(elem->'fullText') <> 'string'
                  OR pg_catalog.btrim(COALESCE(elem->>'fullText', '')) = ''
                  OR pg_catalog.length(pg_catalog.btrim(elem->>'fullText')) > 5000
                )
              )
              OR (
                elem->>'contentKind' = 'ordinary'
                AND pg_catalog.jsonb_typeof(elem->'fullText') <> 'null'
              )
            )
          )
        )
      );

  IF v_invalid_media_element_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready',
      false,
      'resultCode',
      'READINESS_UNAVAILABLE',
      'blockers',
      pg_catalog.to_jsonb(
        ARRAY[
          'Stored preview media state is malformed'
        ]
      )
    );
  END IF;

  -- Duplicate gallery positions are malformed immutable evidence.
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT
          elem->>'galleryPosition' AS gallery_position,
          pg_catalog.count(*) AS position_count
        FROM pg_catalog.jsonb_array_elements(
          v_stored_media_snapshot
        ) elem
        WHERE elem->>'assetType' = 'snapshot_image'
        GROUP BY elem->>'galleryPosition'
        HAVING pg_catalog.count(*) > 1
      ) duplicate_positions
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready',
      false,
      'resultCode',
      'READINESS_UNAVAILABLE',
      'blockers',
      pg_catalog.to_jsonb(
        ARRAY[
          'Stored preview media state is malformed'
        ]
      )
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
  INTO v_canonical_stored_media
  FROM pg_catalog.jsonb_array_elements(
    v_stored_media_snapshot
  ) elem;

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

--------------------------------------------------------------------------------
-- 7. get_project_reconciliation_readiness
--    Forward-redefined from 20260903120000_participant_preview_controlled_links.sql with the same
--    additions as the normal gate: a lifecycle-published project whose gallery is undeclared may
--    not be deployed anew until the project team declares it.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_project_reconciliation_readiness(
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
  v_snapshot_total_count integer;
  v_snapshot_valid_count integer;
  v_snapshot_position_count integer;
  v_snapshot_missing_alt_count integer;
  v_snapshot_long_alt_count integer;
  -- Migration 0057: text-equivalent contract counters.
  v_snapshot_undeclared_count integer;
  v_snapshot_missing_full_text_count integer;
  v_snapshot_long_full_text_count integer;
  v_snapshot_unexpected_full_text_count integer;
  v_incoherent_mapping_count integer;
  v_unexpected_destination_count integer;
  v_invalid_media_element_count integer;
  v_current_snapshot jsonb;
  v_comparable_snapshot jsonb;
  v_current_media_snapshot jsonb;
  v_stored_media_snapshot jsonb;
  v_canonical_current_media jsonb;
  v_canonical_stored_media jsonb;
  v_accessibility_blockers text[];
  v_blockers text[];
BEGIN
  v_blockers := '{}'::text[];

  -- 1. Input validation, identical in strictness to the normal gate.
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

  -- 2. Same serialization key as the normal gate, so reconciliation and preview mutation cannot
  -- interleave for one project.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization.
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

  -- 4. Lock and inspect the authoritative project row.
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

  -- Contradictory persisted state first: a confirmed active preview that also carries a correction.
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

  SELECT pg_catalog.count(*)
    INTO v_unresolved_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project.id
     AND r.status IN ('open', 'in_progress');

  IF v_unresolved_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'CORRECTION_UNRESOLVED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant correction must be resolved']),
      'confirmedPreviewId', null,
      'confirmedAt', null
    );
  END IF;

  -- 5. Reconciliation targets a project that is ALREADY published. Any other status is refused
  -- here rather than by relaxing the normal approved-only gate.
  IF v_project.status <> 'published' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PROJECT_STATE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project status must be published to evaluate deployment reconciliation readiness'])
    );
  END IF;

  -- 6. Accessible content, evaluated against the CURRENT project row.
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

  -- 7. Gallery structural validity against CURRENT snapshot rows.
  --
  -- The normal gate additionally requires each row to be UNPROMOTED (is_public_approved = false,
  -- public_url IS NULL, ...). A published project legitimately carries those publication mappings,
  -- so requiring their absence here would report expected publication state as participant-content
  -- drift. Instead the PRIVATE SOURCE identity is validated exactly as strictly as the normal gate
  -- validates it, and the public mapping is validated separately in step 8.
  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE ma.storage_bucket = v_private_bucket
        AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
        AND pg_catalog.strpos(ma.storage_path, '..') = 0
        AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
        AND ma.file_name = pg_catalog.btrim(ma.file_name)
        AND ma.file_name <> ''
        AND pg_catalog.strpos(ma.file_name, '..') = 0
        AND pg_catalog.strpos(ma.file_name, '/') = 0
        AND pg_catalog.strpos(ma.file_name, E'\\') = 0
        AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
        AND pg_catalog.left(
              ma.storage_path,
              pg_catalog.length('drafts/' || v_project.public_id || '/snapshot_image/')
            ) = 'drafts/' || v_project.public_id || '/snapshot_image/'
        AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
        AND ma.file_size_bytes BETWEEN 1 AND 5242880
        AND ma.gallery_position BETWEEN 1 AND 10
    ),
    pg_catalog.count(DISTINCT ma.gallery_position),
    pg_catalog.count(*) FILTER (
      WHERE pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.alt_text_public IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(ma.alt_text_public)) > 2000
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.image_content_kind IS NULL
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.image_content_kind = 'text_bearing'
        AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) = ''
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.full_text_public IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(ma.full_text_public)) > 5000
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.image_content_kind IS DISTINCT FROM 'text_bearing'
        AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) <> ''
    )
    INTO
      v_snapshot_total_count,
      v_snapshot_valid_count,
      v_snapshot_position_count,
      v_snapshot_missing_alt_count,
      v_snapshot_long_alt_count,
      v_snapshot_undeclared_count,
      v_snapshot_missing_full_text_count,
      v_snapshot_long_full_text_count,
      v_snapshot_unexpected_full_text_count
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.asset_type = 'snapshot_image';

  IF v_snapshot_total_count > 0 THEN
    IF v_snapshot_total_count > 10
       OR v_snapshot_valid_count <> v_snapshot_total_count
       OR v_snapshot_position_count <> v_snapshot_total_count THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot gallery media state is invalid'
      );
    END IF;

    IF v_snapshot_missing_alt_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s alt text is missing', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_long_alt_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s alt text exceeds the 2,000 character safety limit', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND pg_catalog.length(pg_catalog.btrim(ma.alt_text_public)) > 2000
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    -- Migration 0057: the text-equivalent contract is evaluated against the CURRENT rows for
    -- the same reason as the alt text. An undeclared legacy row is a blocker, never an
    -- ordinary photograph; the remedy is a corrected project-team package.
    IF v_snapshot_undeclared_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s content type is missing', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.image_content_kind IS NULL
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_missing_full_text_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s full text is missing', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.image_content_kind = 'text_bearing'
           AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) = ''
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_long_full_text_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s full text exceeds the 5,000 character safety limit', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.full_text_public IS NOT NULL
           AND pg_catalog.length(pg_catalog.btrim(ma.full_text_public)) > 5000
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;

    IF v_snapshot_unexpected_full_text_count > 0 THEN
      v_accessibility_blockers := v_accessibility_blockers || ARRAY(
        SELECT pg_catalog.format('Snapshot image %s is declared ordinary but carries a full text', ma.gallery_position)
          FROM public.media_assets AS ma
         WHERE ma.project_id = v_project.id
           AND ma.asset_type = 'snapshot_image'
           AND ma.image_content_kind IS DISTINCT FROM 'text_bearing'
           AND pg_catalog.btrim(COALESCE(ma.full_text_public, '')) <> ''
         ORDER BY ma.gallery_position, ma.id
      );
    END IF;
  END IF;

  IF pg_catalog.cardinality(v_accessibility_blockers) > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED',
      'blockers', pg_catalog.to_jsonb(v_accessibility_blockers)
    );
  END IF;

  -- 8. Published media mapping must be coherent, and where present must name the deterministic
  -- destination for that exact asset. A half-written mapping, or one pointing somewhere other than
  -- published/<publicId>/<assetType>/<fileName>, is refused instead of being re-derived.
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE NOT (
        (
          ma.public_url IS NULL
          AND ma.public_storage_bucket IS NULL
          AND ma.public_storage_path IS NULL
          AND ma.is_public_approved = false
        )
        OR (
          ma.public_url IS NOT NULL
          AND ma.public_storage_bucket IS NOT NULL
          AND ma.public_storage_path IS NOT NULL
          AND ma.is_public_approved = true
        )
      )
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.public_storage_path IS NOT NULL
        AND ma.public_storage_path IS DISTINCT FROM
            'published/' || v_project.public_id || '/' || ma.asset_type || '/' || ma.file_name
    )
    INTO v_incoherent_mapping_count, v_unexpected_destination_count
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.storage_bucket = v_private_bucket;

  IF v_incoherent_mapping_count > 0 OR v_unexpected_destination_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PUBLISHED_MEDIA_MAPPING_INVALID',
      'blockers', pg_catalog.to_jsonb(ARRAY['Published media mapping does not match its authoritative source asset'])
    );
  END IF;

  -- 9. Exactly one active participant preview, carrying a confirmation.
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

  SELECT c.*
    INTO v_confirmation
    FROM public.participant_preview_confirmations c
   WHERE c.participant_preview_id = v_active_preview.id;

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

  SELECT pg_catalog.count(*)
    INTO v_replacement_count
    FROM public.participant_preview_correction_requests r
   WHERE r.status = 'resolved'
     AND r.replacement_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NULL THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Waiting for participant confirmation');
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

  -- 10. Current participant-facing scalar and taxonomy content, projected exactly as the normal
  -- gate projects it so one confirmed snapshot serves both authorities.
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
      'videoUrl', p.video_url,
      'demoUrl', p.demo_url,
      'repositoryUrl', p.repository_url,
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

  -- Historical-snapshot compatibility for controlled project links.
  --
  -- Previews issued before controlled project links became participant evidence carry none
  -- of the three keys. Such a preview stays equivalent ONLY while the project still has no
  -- controlled link at all. Any populated controlled URL is public-eligible content the
  -- participant was never shown, so it invalidates the confirmation rather than being
  -- grandfathered. Stored snapshots are never rewritten or backfilled to reach this result.
  v_comparable_snapshot := v_current_snapshot;

  IF NOT (v_active_preview.snapshot ? 'videoUrl')
     AND NOT (v_active_preview.snapshot ? 'demoUrl')
     AND NOT (v_active_preview.snapshot ? 'repositoryUrl')
     AND v_current_snapshot->>'videoUrl' IS NULL
     AND v_current_snapshot->>'demoUrl' IS NULL
     AND v_current_snapshot->>'repositoryUrl' IS NULL
  THEN
    v_comparable_snapshot := v_comparable_snapshot - 'videoUrl' - 'demoUrl' - 'repositoryUrl';
  END IF;

  IF v_comparable_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project information changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 11. Current media identity, projected with the SAME keys and semantics as the normal gate --
  -- including galleryPosition and altText -- so an add, a removal, a reorder, a replacement or an
  -- alt-text edit all change the compared object. The only difference is the row filter: the
  -- publication mapping columns are deliberately not part of the participant-content comparison,
  -- because publication is expected to have populated them. They were proved coherent in step 8.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mediaAssetId', ma.id,
        'assetType', ma.asset_type,
        'galleryPosition',
          CASE
            WHEN ma.asset_type = 'snapshot_image'
              THEN ma.gallery_position
            ELSE NULL
          END,
        'fileName', ma.file_name,
        'storageBucket', ma.storage_bucket,
        'storagePath', ma.storage_path,
        'mimeType', ma.mime_type,
        'altText', ma.alt_text_public
      )
      -- Migration 0057: snapshot elements carry the declared text equivalent; poster/PDF
      -- elements keep their exact historical shape (see generate_participant_preview).
      || CASE
           WHEN ma.asset_type = 'snapshot_image'
             THEN pg_catalog.jsonb_build_object(
               'contentKind', ma.image_content_kind,
               'fullText', ma.full_text_public
             )
           ELSE '{}'::jsonb
         END
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
  INTO v_current_media_snapshot
  FROM public.media_assets ma
  WHERE ma.project_id = v_project.id
    AND ma.storage_bucket = v_private_bucket;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
  INTO v_canonical_current_media
  FROM pg_catalog.jsonb_array_elements(v_current_media_snapshot) elem;

  v_stored_media_snapshot := COALESCE(v_active_preview.media_snapshot, '[]'::jsonb);

  -- Stored evidence must use the current immutable gallery contract.
  SELECT pg_catalog.count(*)
    INTO v_invalid_media_element_count
    FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem
   WHERE
      pg_catalog.jsonb_typeof(elem) <> 'object'
      OR pg_catalog.jsonb_typeof(elem->'mediaAssetId') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'assetType') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'fileName') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storageBucket') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storagePath') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'mimeType') <> 'string'
      OR NOT (elem ? 'galleryPosition')
      OR NOT (elem ? 'altText')
      OR (
        elem->>'assetType' = 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(elem->'galleryPosition') <> 'number'
          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(elem->'galleryPosition') = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric
                <> pg_catalog.trunc((elem->>'galleryPosition')::numeric)
              )
              ELSE false
            END
          )
          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(elem->'galleryPosition') = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric < 1
                OR (elem->>'galleryPosition')::numeric > 10
              )
              ELSE false
            END
          )
          OR pg_catalog.jsonb_typeof(elem->'altText') <> 'string'
          OR pg_catalog.btrim(COALESCE(elem->>'altText', '')) = ''
          OR pg_catalog.length(pg_catalog.btrim(elem->>'altText')) > 2000
        )
      )
      OR (
        elem->>'assetType' <> 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(elem->'galleryPosition') <> 'null'
          OR pg_catalog.jsonb_typeof(elem->'altText') <> 'null'
          -- Migration 0057: the text-equivalent keys belong only to snapshot elements.
          OR (elem ? 'contentKind')
          OR (elem ? 'fullText')
        )
      )
      -- Migration 0057: a stored snapshot element either predates the text-equivalent contract
      -- (neither key; reported stale against the current rows below, never rewritten) or carries
      -- a coherent declaration.
      OR (
        elem->>'assetType' = 'snapshot_image'
        AND (
          (elem ? 'contentKind') <> (elem ? 'fullText')
          OR (
            (elem ? 'contentKind')
            AND (
              pg_catalog.jsonb_typeof(elem->'contentKind') <> 'string'
              OR elem->>'contentKind' NOT IN ('ordinary', 'text_bearing')
              OR (
                elem->>'contentKind' = 'text_bearing'
                AND (
                  pg_catalog.jsonb_typeof(elem->'fullText') <> 'string'
                  OR pg_catalog.btrim(COALESCE(elem->>'fullText', '')) = ''
                  OR pg_catalog.length(pg_catalog.btrim(elem->>'fullText')) > 5000
                )
              )
              OR (
                elem->>'contentKind' = 'ordinary'
                AND pg_catalog.jsonb_typeof(elem->'fullText') <> 'null'
              )
            )
          )
        )
      );
  IF v_invalid_media_element_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview media state is malformed'])
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        SELECT
          elem->>'galleryPosition' AS gallery_position,
          pg_catalog.count(*) AS position_count
        FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem
        WHERE elem->>'assetType' = 'snapshot_image'
        GROUP BY elem->>'galleryPosition'
        HAVING pg_catalog.count(*) > 1
      ) duplicate_positions
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview media state is malformed'])
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
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

  -- 12. Every relevant fact is established from authoritative persisted state.
  RETURN pg_catalog.jsonb_build_object(
    'ready', true,
    'resultCode', 'READY',
    'blockers', '[]'::jsonb,
    'confirmedPreviewId', v_active_preview.id,
    'confirmedAt', v_confirmation.confirmed_at::text
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) TO service_role;

--------------------------------------------------------------------------------
-- 8. reserve_participant_correction
--    Forward-redefined from 20260903130000_participant_owned_corrections.sql. Every file element
--    of a corrected package now carries contentKind and fullText; a snapshot must be declared and
--    coherent, and non-snapshot files carry null in both.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_participant_correction(p_token_hash text,p_package_hash text,p_metadata jsonb,p_files jsonb,p_warnings jsonb,p_bucket text,
  p_validation_checks jsonb DEFAULT '[]',p_public_id text DEFAULT NULL,p_admin_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ctx jsonb; s public.participant_correction_submissions; f jsonb; total bigint := 0; n integer; k text; v_name text;
BEGIN
  IF p_token_hash IS NULL THEN
    ctx:=public.pre_preview_package_context(p_public_id,p_admin_id);
    IF EXISTS(SELECT 1 FROM public.participant_correction_submissions WHERE project_id=(ctx->>'projectId')::uuid AND state='frozen') THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  ELSE
    IF p_public_id IS NOT NULL OR p_admin_id IS NOT NULL THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    ctx:=public.participant_correction_context(p_token_hash);
  END IF;
  IF ctx->>'resultCode' <> 'SUCCESS' THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF p_package_hash IS NULL OR p_package_hash !~ '^[a-f0-9]{64}$' OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' OR
     p_metadata->>'publicId' IS DISTINCT FROM ctx->>'publicId' OR octet_length(p_metadata::text)>262144 OR
     p_files IS NULL OR jsonb_typeof(p_files)<>'array' OR jsonb_array_length(p_files) NOT BETWEEN 3 AND 13 OR
     p_warnings IS NULL OR jsonb_typeof(p_warnings)<>'array' OR octet_length(p_warnings::text)>32768 OR
     p_validation_checks IS NULL OR jsonb_typeof(p_validation_checks)<>'array' OR octet_length(p_validation_checks::text)>8192 OR
     p_bucket IS DISTINCT FROM 'participant-corrections-private' OR NOT EXISTS(SELECT 1 FROM storage.buckets b WHERE b.id=p_bucket AND NOT b.public)
  THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_metadata) LOOP
    IF k <> ALL(ARRAY['publicId','title','summary','background','solution','year','program','studyProgram','discipline','industry','industryPartner','academicSupervisor','groupName','participantContactEmail','teamMembers','videoUrl','demoUrl','repositoryUrl','posterText','accessibilityText','snapshotAltText','galleryAltTexts','layoutConfig']) THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['title','summary','program','discipline','groupName','posterText','accessibilityText'] LOOP
    IF jsonb_typeof(p_metadata->k) IS DISTINCT FROM 'string' OR btrim(p_metadata->>k)='' THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  END LOOP;
  IF COALESCE(p_metadata->>'year','') !~ '^[0-9]{4}$' OR (p_metadata->>'year')::integer NOT BETWEEN 1900 AND 2100 OR
     length(p_metadata->>'posterText')>20000 OR length(p_metadata->>'accessibilityText')>2000 OR
     jsonb_typeof(p_metadata->'teamMembers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_metadata->'teamMembers') NOT BETWEEN 1 AND 100 OR
     jsonb_typeof(p_metadata->'layoutConfig') IS DISTINCT FROM 'object'
  THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  FOREACH k IN ARRAY ARRAY['videoUrl','demoUrl','repositoryUrl'] LOOP
    v_name := NULLIF(p_metadata->>k,'');
    IF v_name IS NOT NULL AND (length(v_name)>2048 OR v_name !~* '^https?://[^/?#[:space:]@]+' OR v_name ~ '[[:space:][:cntrl:]]' OR v_name ~* '^https?://[^/?#]*@' OR position(chr(92) in v_name)>0) THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  END LOOP;
  SELECT count(*) INTO n FROM public.programs pr WHERE lower(btrim(pr.name))=lower(btrim(p_metadata->>'program'));
  IF n<>1 THEN RETURN jsonb_build_object('resultCode','LOOKUP_INVALID'); END IF;
  FOR v_name IN SELECT btrim(value) FROM regexp_split_to_table(p_metadata->>'discipline',',') value LOOP
    SELECT count(*) INTO n FROM public.disciplines d WHERE lower(btrim(d.name))=lower(v_name);
    IF n<>1 THEN RETURN jsonb_build_object('resultCode','LOOKUP_INVALID'); END IF;
  END LOOP;
  FOR v_name IN SELECT btrim(value) FROM regexp_split_to_table(COALESCE(p_metadata->>'industry',''),',') value WHERE btrim(value)<>'' LOOP
    SELECT count(*) INTO n FROM public.industry_categories d WHERE lower(btrim(d.name))=lower(v_name);
    IF n<>1 THEN RETURN jsonb_build_object('resultCode','LOOKUP_INVALID'); END IF;
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(p_files) LOOP
    -- Migration 0057: every file element also carries the declared text-equivalent contract.
    IF jsonb_typeof(f)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(f))<>10 OR
       NOT (f ?& ARRAY['role','position','fileName','mimeType','bytes','sha256','altText','storageName','contentKind','fullText']) OR
       COALESCE(f->>'role','') NOT IN ('workbook','poster_image','poster_pdf','snapshot_image') OR
       COALESCE(f->>'sha256','') !~ '^[a-f0-9]{64}$' OR COALESCE(f->>'bytes','') !~ '^[1-9][0-9]{0,8}$' OR
       COALESCE(length(f->>'fileName'),0) NOT BETWEEN 1 AND 100 OR f->>'fileName' ~ '[\/\\[:cntrl:]]' OR position('..' in f->>'fileName')>0 OR
       COALESCE(f->>'storageName','') !~ '^(workbook|poster_image|poster_pdf|snapshot_image-[1-9][0-9]?)\.(xlsx|png|jpg|jpeg|webp|pdf)$'
    THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
    IF (f->>'role'='workbook' AND (f->>'mimeType' IS DISTINCT FROM 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' OR (f->>'bytes')::bigint>5242880)) OR
       (f->>'role'='poster_pdf' AND (f->>'mimeType' IS DISTINCT FROM 'application/pdf' OR (f->>'bytes')::bigint>20971520)) OR
       (f->>'role' IN ('poster_image','snapshot_image') AND (COALESCE(f->>'mimeType','') NOT IN ('image/png','image/jpeg','image/webp') OR (f->>'bytes')::bigint>5242880)) OR
       (f->>'role'='snapshot_image' AND (COALESCE(f->>'position','') !~ '^([1-9]|10)$' OR length(btrim(COALESCE(f->>'altText',''))) NOT BETWEEN 1 AND 2000)) OR
       (f->>'role'<>'snapshot_image' AND (f->'position' IS DISTINCT FROM 'null'::jsonb OR f->'altText' IS DISTINCT FROM 'null'::jsonb)) OR
       -- A corrected package must declare every image; a text-bearing image must carry a bounded full text and an ordinary one none.
       (f->>'role'='snapshot_image' AND (
         jsonb_typeof(f->'contentKind') IS DISTINCT FROM 'string' OR f->>'contentKind' NOT IN ('ordinary','text_bearing') OR
         (f->>'contentKind'='text_bearing' AND (jsonb_typeof(f->'fullText') IS DISTINCT FROM 'string' OR length(btrim(COALESCE(f->>'fullText',''))) NOT BETWEEN 1 AND 5000 OR f->>'fullText' <> btrim(f->>'fullText'))) OR
         (f->>'contentKind'='ordinary' AND f->'fullText' IS DISTINCT FROM 'null'::jsonb))) OR
       (f->>'role'<>'snapshot_image' AND (f->'contentKind' IS DISTINCT FROM 'null'::jsonb OR f->'fullText' IS DISTINCT FROM 'null'::jsonb))
    THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
    total := total+(f->>'bytes')::bigint;
  END LOOP;
  IF total>33554432 OR (SELECT count(DISTINCT value->>'storageName') FROM jsonb_array_elements(p_files))<>jsonb_array_length(p_files) OR
     (SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='workbook')<>1 OR
     (SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='poster_image')<>1 OR
     (SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='poster_pdf')<>1 OR
     (SELECT count(DISTINCT value->>'position') FROM jsonb_array_elements(p_files) WHERE value->>'role'='snapshot_image')<>(SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='snapshot_image')
  THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  SELECT * INTO s FROM public.participant_correction_submissions WHERE package_hash=p_package_hash AND
    (correction_request_id=(ctx->>'correctionId')::uuid OR (source='staff_pre_preview' AND project_id=(ctx->>'projectId')::uuid AND base_version=ctx->>'expectedVersion'));
  IF FOUND THEN
    IF s.metadata IS DISTINCT FROM p_metadata OR s.files IS DISTINCT FROM p_files OR s.warnings IS DISTINCT FROM p_warnings OR s.validation_checks IS DISTINCT FROM p_validation_checks OR s.storage_bucket IS DISTINCT FROM p_bucket OR s.state NOT IN ('preparing','submitted') THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    RETURN jsonb_build_object('resultCode','SUCCESS','submissionId',s.id,'state',s.state,'prefix','corrections/'||s.project_id||'/'||COALESCE(s.correction_request_id,s.id)||'/'||s.id||'/');
  END IF;
  IF (SELECT count(*)>=3 OR COALESCE(sum(total_bytes),0)+total>100663296 FROM public.participant_correction_submissions WHERE
    correction_request_id=(ctx->>'correctionId')::uuid OR (source='staff_pre_preview' AND project_id=(ctx->>'projectId')::uuid AND base_version=ctx->>'expectedVersion')) THEN RETURN jsonb_build_object('resultCode','LIMIT_REACHED'); END IF;
  INSERT INTO public.participant_correction_submissions(correction_request_id,participant_preview_id,project_id,package_hash,metadata,files,warnings,total_bytes,storage_bucket,source,transported_by,base_version,validation_checks)
  VALUES((ctx->>'correctionId')::uuid,(ctx->>'previewId')::uuid,(ctx->>'projectId')::uuid,p_package_hash,p_metadata,p_files,p_warnings,total,p_bucket,
    CASE WHEN p_token_hash IS NULL THEN 'staff_pre_preview' ELSE 'participant_capability' END,p_admin_id,ctx->>'expectedVersion',p_validation_checks) RETURNING * INTO s;
  RETURN jsonb_build_object('resultCode','SUCCESS','submissionId',s.id,'state',s.state,'prefix','corrections/'||s.project_id||'/'||COALESCE(s.correction_request_id,s.id)||'/'||s.id||'/');
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE');
END; $$;

REVOKE ALL ON FUNCTION public.reserve_participant_correction(text,text,jsonb,jsonb,jsonb,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_participant_correction(text,text,jsonb,jsonb,jsonb,text,jsonb,text,uuid) TO service_role;

--------------------------------------------------------------------------------
-- 9. review_participant_correction
--    Forward-redefined from 20260903130000_participant_owned_corrections.sql. Acceptance applies
--    the declared contentKind/fullText from the immutable package to each gallery row exactly like
--    the alt text, and refuses to apply a package reserved before this contract existed.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_participant_correction(
  p_public_id text,p_admin_id uuid,p_submission_id uuid,p_package_hash text,p_expected_version text,p_action text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p public.projects; s public.participant_correction_submissions;
  pp public.participant_previews; r public.participant_preview_correction_requests;
  roles text[]; f jsonb; old_row jsonb; path text; candidate_path text; ctx jsonb;
  v_program_id uuid; v_program_name text; lookup_id uuid; lookup_name text;
  discipline_ids uuid[] := '{}'; industry_ids uuid[] := '{}';
  first_discipline text; first_industry text; acceptance_time timestamptz := now();
BEGIN
  SELECT array_agg(role) INTO roles FROM public.user_roles WHERE user_id=p_admin_id;
  IF NOT COALESCE(('admin'=ANY(roles) OR 'editor'=ANY(roles)) AND ('admin'=ANY(roles) OR 'reviewer'=ANY(roles)),false)
  THEN RETURN jsonb_build_object('resultCode','PERMISSION_DENIED'); END IF;
  IF p_action NOT IN ('begin','accept','return') OR p_action IS NULL OR p_expected_version IS NULL OR p_expected_version !~ '^[a-f0-9]{64}$'
  THEN RETURN jsonb_build_object('resultCode','INVALID_SELECTION'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('participant_preview:'||p_public_id));
  SELECT * INTO p FROM public.projects WHERE public_id=p_public_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  SELECT * INTO s FROM public.participant_correction_submissions WHERE id=p_submission_id AND project_id=p.id AND package_hash=p_package_hash;
  IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF s.source='participant_capability' THEN
    SELECT * INTO pp FROM public.participant_previews WHERE id=s.participant_preview_id AND project_id=p.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    SELECT * INTO r FROM public.participant_preview_correction_requests WHERE id=s.correction_request_id AND participant_preview_id=pp.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  END IF;
  SELECT * INTO s FROM public.participant_correction_submissions WHERE id=s.id FOR UPDATE;
  -- Receipt replay never reapplies content, creates recovery rows or retires rows again.
  IF p_action='accept' AND s.state='accepted' AND s.frozen_version=p_expected_version THEN
    RETURN jsonb_build_object('resultCode','SUCCESS','state','accepted','alreadyApplied',true);
  END IF;
  -- Returning a complete pre-preview package never applies content. Match its
  -- recorded revision identity, even when governance changes made the current draft stale.
  IF s.source='staff_pre_preview' AND p_action='return' AND
     ((s.state='submitted' AND s.base_version=p_expected_version) OR
      (s.state='frozen' AND s.frozen_version=p_expected_version)) THEN
    UPDATE public.participant_correction_submissions SET state='returned',decided_at=now(),decided_by=p_admin_id WHERE id=s.id;
    INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_returned_revision',p_admin_id);
    RETURN jsonb_build_object('resultCode','SUCCESS','state','returned');
  END IF;
  PERFORM 1 FROM public.media_assets WHERE project_id=p.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.project_disciplines WHERE project_id=p.id ORDER BY discipline_id FOR UPDATE;
  PERFORM 1 FROM public.project_industry_categories WHERE project_id=p.id ORDER BY industry_category_id FOR UPDATE;
  PERFORM 1 FROM public.validation_flags WHERE project_id=p.id ORDER BY id FOR UPDATE;
  IF public.participant_correction_project_version(p.id) IS DISTINCT FROM p_expected_version
  THEN RETURN jsonb_build_object('resultCode','STALE_REVISION'); END IF;
  IF s.source='participant_capability' AND (SELECT count(*) FROM public.participant_preview_correction_requests cr JOIN public.participant_previews pv ON pv.id=cr.participant_preview_id WHERE pv.project_id=p.id AND cr.status IN ('open','in_progress'))<>1
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF EXISTS(SELECT 1 FROM public.public_feed_operations WHERE (project_id=p.id OR kind IN ('activation','rollback')) AND state NOT IN ('COMPLETED','FAILED')) OR
     EXISTS(SELECT 1 FROM public.publication_attempts WHERE project_id=p.id AND state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM public.public_removal_attempts WHERE project_id=p.id AND state NOT IN ('completed','failed'))
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  -- Published media or a public bucket is never silently normalized or retired.
  IF (s.source='participant_capability' AND p.status NOT IN ('approved','changes_requested')) OR p.poster_url IS NOT NULL OR p.poster_pdf_url IS NOT NULL OR COALESCE(cardinality(p.snapshots),0)<>0 OR
     EXISTS(SELECT 1 FROM public.media_assets m LEFT JOIN storage.buckets b ON b.id=m.storage_bucket WHERE m.project_id=p.id AND
       (m.is_public_approved IS DISTINCT FROM false OR m.public_url IS NOT NULL OR m.public_storage_bucket IS NOT NULL OR m.public_storage_path IS NOT NULL OR b.public IS DISTINCT FROM false OR m.asset_type NOT IN ('poster_image','poster_pdf','snapshot_image')))
  THEN RETURN jsonb_build_object('resultCode','UNSAFE_REVISION'); END IF;

  -- Migration 0057: a package reserved before the text-equivalent contract cannot be applied,
  -- because acceptance would register undeclared gallery media. Its author resubmits.
  IF p_action='accept' AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.files) f0 WHERE f0->>'role'='snapshot_image' AND NOT (f0 ?& ARRAY['contentKind','fullText']))
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF s.source='staff_pre_preview' THEN
    ctx:=public.pre_preview_package_context(p_public_id,p_admin_id);
    IF ctx->>'resultCode'<>'SUCCESS' OR s.base_version IS DISTINCT FROM p_expected_version
    THEN RETURN jsonb_build_object('resultCode','STALE_REVISION'); END IF;
    IF p_action='begin' THEN
      IF s.state<>'submitted' OR EXISTS(SELECT 1 FROM public.participant_correction_submissions WHERE project_id=p.id AND state='frozen')
      THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
      UPDATE public.participant_correction_submissions SET state='frozen',frozen_at=now(),frozen_by=p_admin_id,frozen_version=p_expected_version WHERE id=s.id;
      INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_began_review',p_admin_id);
      RETURN jsonb_build_object('resultCode','SUCCESS','state','frozen');
    END IF;
    IF p_action<>'accept' OR s.state<>'frozen' OR s.frozen_version IS DISTINCT FROM p_expected_version
    THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  ELSE
  IF p_action='begin' THEN
    IF s.state<>'submitted' OR r.status<>'open' OR p.status<>'approved' OR pp.status<>'active' OR pp.revoked_at IS NOT NULL OR pp.expires_at<=now() OR
       EXISTS(SELECT 1 FROM public.participant_preview_confirmations WHERE participant_preview_id=pp.id) OR
       EXISTS(SELECT 1 FROM public.participant_previews WHERE project_id=p.id AND status='active' AND id<>pp.id)
    THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    -- Only existing lifecycle fields change. Snapshot JSON, comment and response evidence stay intact.
    UPDATE public.participant_previews SET status='revoked',revoked_at=now(),revoked_by=p_admin_id WHERE id=pp.id;
    UPDATE public.projects SET status='changes_requested' WHERE id=p.id;
    UPDATE public.participant_preview_correction_requests SET status='in_progress',resolution_started_at=now(),resolution_started_by=p_admin_id WHERE id=r.id;
    UPDATE public.participant_correction_submissions SET state='frozen',frozen_at=now(),frozen_by=p_admin_id,frozen_version=public.participant_correction_project_version(p.id) WHERE id=s.id;
    INSERT INTO public.approval_records(project_id,admin_id,action_taken,from_status,to_status,comments)
      VALUES(p.id,p_admin_id,'request_changes','approved','changes_requested','Review started for a participant-authored correction package');
    INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_began_review',p_admin_id);
    RETURN jsonb_build_object('resultCode','SUCCESS','state','frozen');
  END IF;

  IF p_action='return' THEN
    IF NOT (s.state='frozen' AND r.status='in_progress' AND p.status='changes_requested' AND pp.status='revoked' AND s.frozen_version=p_expected_version)
    THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    UPDATE public.participant_correction_submissions SET state='returned',decided_at=now(),decided_by=p_admin_id WHERE id=s.id;
    INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_returned_revision',p_admin_id);
    RETURN jsonb_build_object('resultCode','SUCCESS','state','returned');
  END IF;

  IF s.state<>'frozen' OR r.status<>'in_progress' OR p.status<>'changes_requested' OR pp.status<>'revoked' OR pp.revoked_at IS NULL OR s.frozen_version IS DISTINCT FROM p_expected_version
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  END IF;
  SELECT pr.id,pr.name INTO STRICT v_program_id,v_program_name FROM public.programs pr WHERE lower(btrim(pr.name))=lower(btrim(s.metadata->>'program'));
  FOR lookup_name IN SELECT btrim(value) FROM regexp_split_to_table(s.metadata->>'discipline',',') value LOOP
    SELECT d.id,d.name INTO STRICT lookup_id,lookup_name FROM public.disciplines d WHERE lower(btrim(d.name))=lower(lookup_name);
    discipline_ids:=array_append(discipline_ids,lookup_id); first_discipline:=COALESCE(first_discipline,lookup_name);
  END LOOP;
  FOR lookup_name IN SELECT btrim(value) FROM regexp_split_to_table(COALESCE(s.metadata->>'industry',''),',') value WHERE btrim(value)<>'' LOOP
    SELECT i.id,i.name INTO STRICT lookup_id,lookup_name FROM public.industry_categories i WHERE lower(btrim(i.name))=lower(lookup_name);
    industry_ids:=array_append(industry_ids,lookup_id); first_industry:=COALESCE(first_industry,lookup_name);
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(s.files) LOOP
    candidate_path:='corrections/'||p.id||'/'||COALESCE(s.correction_request_id,s.id)||'/'||s.id||'/'||(f->>'storageName');
    path:='drafts/'||p.public_id||'/'||(f->>'role')||'/corrections/'||s.id||'/'||(f->>'storageName')||'/'||(f->>'fileName');
    IF NOT EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE NOT b.public AND o.bucket_id=s.storage_bucket AND o.name=candidate_path AND (o.metadata->>'size')::bigint=(f->>'bytes')::bigint AND o.metadata->>'mimetype'=f->>'mimeType') OR
       (f->>'role'<>'workbook' AND NOT EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE NOT b.public AND o.bucket_id='project-drafts-private' AND o.name=path AND (o.metadata->>'size')::bigint=(f->>'bytes')::bigint AND o.metadata->>'mimetype'=f->>'mimeType'))
    THEN RETURN jsonb_build_object('resultCode','STORAGE_INCOMPLETE'); END IF;
  END LOOP;

  -- Recovery capture and all database changes share this function's subtransaction.
  -- Failure anywhere, including a recovery insert or retirement trigger, rolls everything back.
  INSERT INTO public.participant_correction_prior_revisions(submission_id,project_id,correction_request_id,package_hash,expected_version,accepted_by,project_record,media_records,discipline_records,industry_records,validation_records,captured_at)
  VALUES(s.id,p.id,r.id,s.package_hash,p_expected_version,p_admin_id,to_jsonb(p),
    COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.media_assets m WHERE project_id=p.id),'[]'),
    COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY discipline_id) FROM public.project_disciplines d WHERE project_id=p.id),'[]'),
    COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY industry_category_id) FROM public.project_industry_categories i WHERE project_id=p.id),'[]'),
    COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.validation_flags v WHERE project_id=p.id),'[]'),acceptance_time);
  INSERT INTO public.participant_correction_recovery_rows(submission_id,project_id,source_table,original_identity,row_data)
    SELECT s.id,p.id,'media_assets',jsonb_build_object('id',m.id),to_jsonb(m) FROM public.media_assets m WHERE project_id=p.id
    UNION ALL SELECT s.id,p.id,'project_disciplines',jsonb_build_object('project_id',d.project_id,'discipline_id',d.discipline_id),to_jsonb(d) FROM public.project_disciplines d WHERE project_id=p.id
    UNION ALL SELECT s.id,p.id,'project_industry_categories',jsonb_build_object('project_id',i.project_id,'industry_category_id',i.industry_category_id),to_jsonb(i) FROM public.project_industry_categories i WHERE project_id=p.id;

  UPDATE public.projects SET title=s.metadata->>'title',summary=s.metadata->>'summary',background=s.metadata->>'background',solution=s.metadata->>'solution',
    year=(s.metadata->>'year')::integer,program_id=v_program_id,program_name=v_program_name,
    study_program=s.metadata->>'studyProgram',discipline=first_discipline,industry=first_industry,industry_partner=s.metadata->>'industryPartner',
    academic_supervisor=s.metadata->>'academicSupervisor',group_name=s.metadata->>'groupName',participant_contact_email=NULLIF(s.metadata->>'participantContactEmail',''),
    team_members=ARRAY(SELECT jsonb_array_elements_text(s.metadata->'teamMembers')),poster_text_public=s.metadata->>'posterText',accessibility_text_public=s.metadata->>'accessibilityText',
    video_url=NULLIF(s.metadata->>'videoUrl',''),demo_url=NULLIF(s.metadata->>'demoUrl',''),repository_url=NULLIF(s.metadata->>'repositoryUrl',''),layout_config=s.metadata->'layoutConfig',
    package_validation=jsonb_build_object('valid',true,'source',s.source,'submissionId',s.id,'packageHash',s.package_hash,'warnings',s.warnings,'passedRules',s.validation_checks),
    validation_errors='{}',validation_warnings=ARRAY(SELECT jsonb_array_elements_text(s.warnings)),validation_flags_cache=NULL
  WHERE id=p.id;
  -- Rule/field identity comes from server revalidation of this exact package.
  -- Keep historical rows and capture their old disposition before recording a
  -- verified resolution. Unknown/governance rules and still-failing rules remain open.
  FOR old_row IN SELECT to_jsonb(v) FROM public.validation_flags v WHERE v.project_id=p.id AND v.resolved IS NOT TRUE AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(s.validation_checks) c WHERE c->>'ruleCode'=v.rule_code AND c->>'fieldName' IS NOT DISTINCT FROM v.field_name)
  LOOP
    INSERT INTO public.participant_correction_recovery_rows(submission_id,project_id,source_table,original_identity,row_data)
      VALUES(s.id,p.id,'validation_flags',jsonb_build_object('id',old_row->>'id'),old_row);
    UPDATE public.validation_flags v SET resolved=true,resolved_at=acceptance_time,resolved_by=p_admin_id
      WHERE v.id=(old_row->>'id')::uuid AND v.project_id=p.id AND to_jsonb(v)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  INSERT INTO public.project_disciplines(project_id,discipline_id) SELECT p.id,unnest(discipline_ids) ON CONFLICT DO NOTHING;
  INSERT INTO public.project_industry_categories(project_id,industry_category_id) SELECT p.id,unnest(industry_ids) ON CONFLICT DO NOTHING;

  -- Retire only exact, recoverably captured obsolete project mapping rows, never catalogues.
  FOR old_row IN SELECT to_jsonb(d) FROM public.project_disciplines d WHERE project_id=p.id AND NOT (discipline_id=ANY(discipline_ids)) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.participant_correction_recovery_rows rr WHERE rr.submission_id=s.id AND rr.project_id=p.id AND rr.source_table='project_disciplines' AND rr.row_data=old_row) THEN RAISE EXCEPTION 'RECOVERY_REQUIRED'; END IF;
    DELETE FROM public.project_disciplines d WHERE d.project_id=p.id AND d.discipline_id=(old_row->>'discipline_id')::uuid AND to_jsonb(d)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  FOR old_row IN SELECT to_jsonb(i) FROM public.project_industry_categories i WHERE project_id=p.id AND NOT (industry_category_id=ANY(industry_ids)) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.participant_correction_recovery_rows rr WHERE rr.submission_id=s.id AND rr.project_id=p.id AND rr.source_table='project_industry_categories' AND rr.row_data=old_row) THEN RAISE EXCEPTION 'RECOVERY_REQUIRED'; END IF;
    DELETE FROM public.project_industry_categories i WHERE i.project_id=p.id AND i.industry_category_id=(old_row->>'industry_category_id')::uuid AND to_jsonb(i)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  FOR old_row IN SELECT to_jsonb(m) FROM public.media_assets m WHERE project_id=p.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.files) f0 WHERE f0->>'role'=m.asset_type AND (f0->>'position')::integer IS NOT DISTINCT FROM m.gallery_position) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.participant_correction_recovery_rows rr WHERE rr.submission_id=s.id AND rr.project_id=p.id AND rr.source_table='media_assets' AND rr.row_data=old_row) THEN RAISE EXCEPTION 'RECOVERY_REQUIRED'; END IF;
    DELETE FROM public.media_assets m WHERE m.project_id=p.id AND m.id=(old_row->>'id')::uuid AND to_jsonb(m)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(s.files) WHERE value->>'role'<>'workbook' LOOP
    path:='drafts/'||p.public_id||'/'||(f->>'role')||'/corrections/'||s.id||'/'||(f->>'storageName')||'/'||(f->>'fileName');
    UPDATE public.media_assets SET file_name=f->>'fileName',storage_bucket='project-drafts-private',storage_path=path,mime_type=f->>'mimeType',file_size_bytes=(f->>'bytes')::bigint,alt_text_public=f->>'altText',
      image_content_kind=f->>'contentKind',full_text_public=f->>'fullText'
      WHERE project_id=p.id AND asset_type=f->>'role' AND gallery_position IS NOT DISTINCT FROM (f->>'position')::integer;
    IF NOT FOUND THEN
      INSERT INTO public.media_assets(project_id,asset_type,gallery_position,file_name,storage_bucket,storage_path,mime_type,file_size_bytes,alt_text_public,image_content_kind,full_text_public,is_public_approved)
      VALUES(p.id,f->>'role',(f->>'position')::integer,f->>'fileName','project-drafts-private',path,f->>'mimeType',(f->>'bytes')::bigint,f->>'altText',f->>'contentKind',f->>'fullText',false);
    END IF;
  END LOOP;
  UPDATE public.participant_correction_submissions SET state='accepted',decided_at=acceptance_time,decided_by=p_admin_id WHERE id=s.id;
  INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id,created_at) VALUES(s.id,'staff_accepted_revision',p_admin_id,acceptance_time);
  RETURN jsonb_build_object('resultCode','SUCCESS','state','accepted','alreadyApplied',false);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE');
END; $$;

REVOKE ALL ON FUNCTION public.review_participant_correction(text,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_participant_correction(text,uuid,uuid,text,text,text) TO service_role;

--------------------------------------------------------------------------------
-- 10. Release capability sentinel.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT '20260911120000_gallery_full_text_equivalents|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()
  TO service_role;

COMMIT;
