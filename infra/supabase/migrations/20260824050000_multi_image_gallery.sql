-- Migration: 20260824050000_multi_image_gallery.sql
-- Description:
--   Adds deterministic multi-image gallery positions to media_assets while
--   preserving the existing poster image/PDF semantics and private media staging.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Add deterministic gallery position.
-- ---------------------------------------------------------------------------

ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS gallery_position integer;

-- Existing Task 2 snapshot rows represented snapshot-1.png.
-- Preserve them as gallery position 1.
UPDATE public.media_assets
   SET gallery_position = 1
 WHERE asset_type = 'snapshot_image'
   AND gallery_position IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Replace the old one-row-per-asset-type uniqueness model.
-- ---------------------------------------------------------------------------

ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_project_asset_type_unique;

-- poster_image and poster_pdf remain fixed single-role assets:
-- at most one of each per project.
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_project_non_snapshot_asset_type_unique
  ON public.media_assets (project_id, asset_type)
  WHERE asset_type <> 'snapshot_image';

-- snapshot_image identity is now project + deterministic gallery position.
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_project_gallery_position_unique
  ON public.media_assets (project_id, gallery_position)
  WHERE asset_type = 'snapshot_image';

-- ---------------------------------------------------------------------------
-- 3. Enforce gallery-position semantics.
-- ---------------------------------------------------------------------------

ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_gallery_position_check;

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_gallery_position_check
  CHECK (
    (
      asset_type = 'snapshot_image'
      AND gallery_position BETWEEN 1 AND 10
    )
    OR
    (
      asset_type <> 'snapshot_image'
      AND gallery_position IS NULL
    )
  );
  -- ---------------------------------------------------------------------------
-- 4. Replace browser media finalization with gallery-aware persistence.
-- ---------------------------------------------------------------------------

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
      alt_text_public
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
      v_alt_text
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
        ma.gallery_position
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
        ma.gallery_position
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

COMMIT;