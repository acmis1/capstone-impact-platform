-- Migration: 20260810120000_atomic_browser_import_media_stage.sql
-- Description: Atomic, service-role-only browser import media staging finalization and ledger

BEGIN;

-- 1. Enforce idempotency-friendly uniqueness on media_assets.
--    Each project has at most one row per asset type, and each stored object is registered once.
ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_project_asset_type_unique;

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_project_asset_type_unique
  UNIQUE (project_id, asset_type);

ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_bucket_path_unique;

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_bucket_path_unique
  UNIQUE (storage_bucket, storage_path);

-- 2. Create browser_import_media_commits idempotency ledger table.
--    One row per batch: records the exact media selection that was completed so that
--    exact retries converge and unrelated/foreign requests are rejected.
CREATE TABLE IF NOT EXISTS public.browser_import_media_commits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL UNIQUE REFERENCES public.import_batches(id) ON DELETE CASCADE,
    media_intent_hash TEXT NOT NULL CONSTRAINT check_media_intent_hash_hex CHECK (media_intent_hash ~ '^[a-f0-9]{64}$'),
    metadata_intent_hash TEXT NOT NULL CONSTRAINT check_metadata_intent_hash_hex CHECK (metadata_intent_hash ~ '^[a-f0-9]{64}$'),
    asset_count INTEGER NOT NULL CHECK (asset_count >= 0),
    completed_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_browser_import_media_commits_batch_id ON public.browser_import_media_commits(batch_id);

ALTER TABLE public.browser_import_media_commits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.browser_import_media_commits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.browser_import_media_commits TO service_role;

-- 3. Service-role-only atomic media stage finalization RPC.
--    Storage uploads happen outside this transaction (Postgres and Supabase Storage are not
--    one distributed transaction); this RPC only performs the atomic database registration:
--    media_assets rows + idempotency ledger + import_batches completion, all-or-nothing.
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
      is_public_approved
    ) VALUES (
      v_project.id,
      v_asset_type,
      v_file_name,
      v_storage_bucket,
      v_storage_path,
      NULL,
      NULLIF(v_mime_type, ''),
      v_file_size_bytes,
      false
    )
    ON CONFLICT (project_id, asset_type) DO NOTHING;

    -- Verify convergence: the row for (project, assetType) must point at exactly this object
    SELECT ma.storage_bucket, ma.storage_path INTO v_existing_asset
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id
       AND ma.asset_type = v_asset_type;

    IF NOT FOUND OR v_existing_asset.storage_bucket <> v_storage_bucket OR v_existing_asset.storage_path <> v_storage_path THEN
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

-- Security hardening
REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) TO service_role;

COMMIT;
