-- Migration 0019: controlled publication execution foundation.
--
-- PostgreSQL and Storage are deliberately coordinated as separate systems:
-- a durable, globally exclusive attempt binds exact readiness/artifact evidence;
-- storage is written and verified outside a database transaction; then a short
-- atomic finalization transaction revalidates and commits all authoritative DB state.

BEGIN;

ALTER TABLE public.media_assets
  ADD COLUMN public_storage_bucket text,
  ADD COLUMN public_storage_path text;

UPDATE public.media_assets
   SET public_storage_bucket = storage_bucket,
       public_storage_path = storage_path
 WHERE is_public_approved = true
   AND public_url IS NOT NULL;

CREATE OR REPLACE FUNCTION public.normalize_public_media_mapping()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.is_public_approved = true
     AND NEW.public_url IS NOT NULL
     AND NEW.public_storage_bucket IS NULL
     AND NEW.public_storage_path IS NULL THEN
    NEW.public_storage_bucket := NEW.storage_bucket;
    NEW.public_storage_path := NEW.storage_path;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER normalize_public_media_mapping_before_write
BEFORE INSERT OR UPDATE ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.normalize_public_media_mapping();

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_public_mapping_coherent CHECK (
    (is_public_approved = false AND public_url IS NULL
      AND public_storage_bucket IS NULL AND public_storage_path IS NULL)
    OR
    (is_public_approved = true AND public_url IS NOT NULL
      AND public_storage_bucket IS NOT NULL AND public_storage_path IS NOT NULL)
  );

CREATE TABLE public.publication_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  public_id text NOT NULL,
  admin_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  confirmed_preview_id uuid NOT NULL REFERENCES public.participant_previews(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL,
  candidate_record_count integer NOT NULL CHECK (candidate_record_count > 0),
  candidate_feed_hash text NOT NULL CHECK (candidate_feed_hash ~ '^[0-9a-f]{64}$'),
  candidate_feed_content text NOT NULL,
  feed_storage_bucket text NOT NULL CHECK (pg_catalog.btrim(feed_storage_bucket) <> ''),
  feed_storage_path text NOT NULL CHECK (pg_catalog.btrim(feed_storage_path) <> ''),
  feed_public_url text NOT NULL CHECK (pg_catalog.btrim(feed_public_url) <> ''),
  previous_feed_existed boolean NOT NULL,
  previous_feed_content text,
  media_manifest jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(media_manifest) = 'array'),
  state text NOT NULL CHECK (state IN ('prepared', 'storage_written', 'completed', 'failed', 'compensation_failed')),
  execution_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at timestamptz NOT NULL,
  storage_verified_at timestamptz,
  published_snapshot_id uuid REFERENCES public.published_snapshots(id) ON DELETE SET NULL,
  publish_audit_record_id uuid REFERENCES public.approval_records(id) ON DELETE SET NULL,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'),
  compensation_failure_code text CHECK (compensation_failure_code IS NULL OR compensation_failure_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT publication_attempt_previous_feed_coherent CHECK (
    (previous_feed_existed = true AND previous_feed_content IS NOT NULL)
    OR (previous_feed_existed = false AND previous_feed_content IS NULL)
  ),
  CONSTRAINT publication_attempt_terminal_state_coherent CHECK (
    (state = 'completed' AND completed_at IS NOT NULL AND published_snapshot_id IS NOT NULL
      AND publish_audit_record_id IS NOT NULL AND failure_code IS NULL)
    OR (state IN ('failed', 'compensation_failed') AND failed_at IS NOT NULL AND failure_code IS NOT NULL
      AND completed_at IS NULL AND published_snapshot_id IS NULL AND publish_audit_record_id IS NULL)
    OR (state IN ('prepared', 'storage_written') AND completed_at IS NULL AND failed_at IS NULL
      AND published_snapshot_id IS NULL AND publish_audit_record_id IS NULL AND failure_code IS NULL)
  )
);

CREATE INDEX publication_attempts_project_id_idx ON public.publication_attempts(project_id);
CREATE UNIQUE INDEX publication_attempts_one_active_global_idx
  ON public.publication_attempts ((true))
  WHERE state IN ('prepared', 'storage_written', 'compensation_failed');
CREATE UNIQUE INDEX publication_attempts_one_completed_project_idx
  ON public.publication_attempts(project_id)
  WHERE state = 'completed';
CREATE UNIQUE INDEX publication_attempts_snapshot_idx
  ON public.publication_attempts(published_snapshot_id)
  WHERE published_snapshot_id IS NOT NULL;

ALTER TABLE public.publication_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_all_publication_attempts ON public.publication_attempts
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.publication_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.publication_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.guard_active_publication_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_other_project_id uuid;
  v_attempt_id uuid;
  v_marker text;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    v_project_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME IN ('media_assets', 'participant_previews', 'project_disciplines', 'project_industry_categories') THEN
    v_project_id := COALESCE(NEW.project_id, OLD.project_id);
    IF TG_OP = 'UPDATE' THEN v_other_project_id := OLD.project_id; END IF;
  ELSIF TG_TABLE_NAME IN ('participant_preview_confirmations', 'participant_preview_correction_requests') THEN
    SELECT pp.project_id INTO v_project_id
      FROM public.participant_previews pp
     WHERE pp.id = COALESCE(NEW.participant_preview_id, OLD.participant_preview_id);
  END IF;

  v_marker := pg_catalog.current_setting('app.publication_attempt_id', true);
  SELECT pa.id INTO v_attempt_id
    FROM public.publication_attempts pa
   WHERE pa.project_id = v_project_id
     AND pa.state IN ('prepared', 'storage_written', 'compensation_failed')
   LIMIT 1;

  IF v_attempt_id IS NOT NULL AND COALESCE(v_marker, '') <> v_attempt_id::text THEN
    RAISE EXCEPTION 'PUBLICATION_IN_PROGRESS';
  END IF;

  IF v_other_project_id IS NOT NULL AND v_other_project_id IS DISTINCT FROM v_project_id THEN
    SELECT pa.id INTO v_attempt_id
      FROM public.publication_attempts pa
     WHERE pa.project_id = v_other_project_id
       AND pa.state IN ('prepared', 'storage_written', 'compensation_failed')
     LIMIT 1;
    IF v_attempt_id IS NOT NULL AND COALESCE(v_marker, '') <> v_attempt_id::text THEN
      RAISE EXCEPTION 'PUBLICATION_IN_PROGRESS';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_projects_during_publication
  BEFORE UPDATE OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_publication_attempt();
CREATE TRIGGER guard_media_assets_during_publication
  BEFORE INSERT OR UPDATE OR DELETE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_publication_attempt();
CREATE TRIGGER guard_participant_previews_during_publication
  BEFORE INSERT OR UPDATE OR DELETE ON public.participant_previews
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_publication_attempt();
CREATE TRIGGER guard_preview_confirmations_during_publication
  BEFORE INSERT OR UPDATE OR DELETE ON public.participant_preview_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_publication_attempt();
CREATE TRIGGER guard_preview_corrections_during_publication
  BEFORE INSERT OR UPDATE OR DELETE ON public.participant_preview_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_publication_attempt();
CREATE TRIGGER guard_project_disciplines_during_publication
  BEFORE INSERT OR UPDATE OR DELETE ON public.project_disciplines
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_publication_attempt();
CREATE TRIGGER guard_project_industries_during_publication
  BEFORE INSERT OR UPDATE OR DELETE ON public.project_industry_categories
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_publication_attempt();

CREATE OR REPLACE FUNCTION public.begin_publication_attempt(
  p_public_id text,
  p_admin_id uuid,
  p_private_bucket text,
  p_confirmed_preview_id uuid,
  p_confirmed_at timestamptz,
  p_candidate_record_count integer,
  p_candidate_feed_hash text,
  p_candidate_feed_content text,
  p_feed_storage_bucket text,
  p_feed_storage_path text,
  p_feed_public_url text,
  p_previous_feed_existed boolean,
  p_previous_feed_content text,
  p_media_manifest jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_roles text[];
  v_readiness jsonb;
  v_project_id uuid;
  v_existing public.publication_attempts%ROWTYPE;
  v_attempt public.publication_attempts%ROWTYPE;
  v_candidate jsonb;
BEGIN
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$'
    OR p_admin_id IS NULL OR p_confirmed_preview_id IS NULL OR p_confirmed_at IS NULL
    OR p_candidate_record_count IS NULL OR p_candidate_record_count <= 0
    OR p_candidate_feed_hash IS NULL OR p_candidate_feed_hash !~ '^[0-9a-f]{64}$'
    OR p_candidate_feed_content IS NULL OR pg_catalog.octet_length(p_candidate_feed_content) > 10485760
    OR pg_catalog.btrim(COALESCE(p_private_bucket, '')) = ''
    OR pg_catalog.btrim(COALESCE(p_feed_storage_bucket, '')) = ''
    OR pg_catalog.btrim(COALESCE(p_feed_storage_path, '')) = ''
    OR pg_catalog.btrim(COALESCE(p_feed_public_url, '')) = ''
    OR p_previous_feed_existed IS NULL
    OR (p_previous_feed_existed AND p_previous_feed_content IS NULL)
    OR (NOT p_previous_feed_existed AND p_previous_feed_content IS NOT NULL)
    OR p_media_manifest IS NULL OR pg_catalog.jsonb_typeof(p_media_manifest) <> 'array'
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;

  BEGIN
    v_candidate := p_candidate_feed_content::jsonb;
  EXCEPTION WHEN others THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT');
  END;
  IF pg_catalog.jsonb_typeof(v_candidate) <> 'array'
    OR pg_catalog.jsonb_array_length(v_candidate) <> p_candidate_record_count
    OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_candidate_feed_content, 'UTF8'), 'sha256'), 'hex') <> p_candidate_feed_hash
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT'); END IF;

  SELECT pg_catalog.array_agg(ur.role) INTO v_roles FROM public.user_roles ur WHERE ur.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- Every controlled publication acquires locks in this order:
  -- global publication advisory lock -> participant-preview advisory/rows -> project row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));

  SELECT * INTO v_existing FROM public.publication_attempts
   WHERE state IN ('prepared', 'storage_written', 'compensation_failed')
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', CASE WHEN v_existing.state = 'compensation_failed' THEN 'COMPENSATION_INCOMPLETE' ELSE 'PUBLICATION_IN_PROGRESS' END,
      'attemptId', v_existing.id::text
    );
  END IF;

  SELECT * INTO v_existing FROM public.publication_attempts
   WHERE public_id = v_public_id AND state = 'completed'
   ORDER BY completed_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_COMPLETED', 'attemptId', v_existing.id::text);
  END IF;

  v_readiness := public.get_project_publication_readiness(v_public_id, p_admin_id, p_private_bucket);
  IF v_readiness->>'resultCode' <> 'READY' OR COALESCE((v_readiness->>'ready')::boolean, false) = false THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY', 'readinessCode', COALESCE(v_readiness->>'resultCode', 'READINESS_UNAVAILABLE'));
  END IF;
  IF v_readiness->>'confirmedPreviewId' <> p_confirmed_preview_id::text
    OR (v_readiness->>'confirmedAt')::timestamptz IS DISTINCT FROM p_confirmed_at
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_EVIDENCE'); END IF;

  SELECT p.id INTO v_project_id FROM public.projects p
   WHERE p.public_id = v_public_id AND p.deleted_at IS NULL AND p.status = 'approved';
  IF v_project_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY', 'readinessCode', 'INVALID_PROJECT_STATE'); END IF;

  INSERT INTO public.publication_attempts(
    project_id, public_id, admin_id, confirmed_preview_id, confirmed_at,
    candidate_record_count, candidate_feed_hash, candidate_feed_content,
    feed_storage_bucket, feed_storage_path, feed_public_url,
    previous_feed_existed, previous_feed_content, media_manifest,
    state, lease_expires_at
  ) VALUES (
    v_project_id, v_public_id, p_admin_id, p_confirmed_preview_id, p_confirmed_at,
    p_candidate_record_count, p_candidate_feed_hash, p_candidate_feed_content,
    p_feed_storage_bucket, p_feed_storage_path, p_feed_public_url,
    p_previous_feed_existed, p_previous_feed_content, p_media_manifest,
    'prepared', pg_catalog.now() + interval '5 minutes'
  ) RETURNING * INTO v_attempt;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'ATTEMPT_STARTED',
    'attemptId', v_attempt.id::text,
    'executionToken', v_attempt.execution_token::text,
    'state', v_attempt.state
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_publication_attempt(p_public_id text, p_admin_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_roles text[];
  v_attempt public.publication_attempts%ROWTYPE;
BEGIN
  SELECT pg_catalog.array_agg(ur.role) INTO v_roles FROM public.user_roles ur WHERE ur.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.publication_attempts
   WHERE public_id = pg_catalog.btrim(COALESCE(p_public_id, ''))
     AND state IN ('prepared', 'storage_written', 'compensation_failed')
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.state = 'compensation_failed' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPENSATION_INCOMPLETE', 'attemptId', v_attempt.id::text); END IF;
  IF v_attempt.lease_expires_at > pg_catalog.now() THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLICATION_IN_PROGRESS', 'attemptId', v_attempt.id::text); END IF;
  UPDATE public.publication_attempts SET execution_token = gen_random_uuid(), lease_expires_at = pg_catalog.now() + interval '5 minutes', updated_at = pg_catalog.now()
   WHERE id = v_attempt.id RETURNING * INTO v_attempt;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_CLAIMED', 'attemptId', v_attempt.id::text,
    'executionToken', v_attempt.execution_token::text, 'state', v_attempt.state);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_publication_attempt_storage_written(
  p_attempt_id uuid, p_execution_token uuid, p_verified_feed_hash text, p_verified_record_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_attempt public.publication_attempts%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.publication_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_TOKEN_MISMATCH'); END IF;
  IF v_attempt.state NOT IN ('prepared', 'storage_written') THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ATTEMPT_STATE'); END IF;
  IF v_attempt.candidate_feed_hash IS DISTINCT FROM p_verified_feed_hash
    OR v_attempt.candidate_record_count IS DISTINCT FROM p_verified_record_count
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;
  UPDATE public.publication_attempts SET state = 'storage_written', storage_verified_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE id = p_attempt_id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'STORAGE_WRITTEN', 'attemptId', p_attempt_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_publication_attempt(p_attempt_id uuid, p_execution_token uuid, p_private_bucket text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.publication_attempts%ROWTYPE;
  v_readiness jsonb;
  v_project_status text;
  v_snapshot_id uuid;
  v_audit_id uuid;
  v_poster_url text;
  v_poster_pdf_url text;
  v_snapshots text[];
  v_media jsonb;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.publication_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.state = 'completed' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_COMPLETED', 'attemptId', v_attempt.id::text, 'snapshotId', v_attempt.published_snapshot_id::text); END IF;
  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_TOKEN_MISMATCH'); END IF;
  IF v_attempt.state <> 'storage_written' OR v_attempt.storage_verified_at IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ATTEMPT_STATE'); END IF;

  v_readiness := public.get_project_publication_readiness(v_attempt.public_id, v_attempt.admin_id, p_private_bucket);
  IF v_readiness->>'resultCode' <> 'READY' OR COALESCE((v_readiness->>'ready')::boolean, false) = false THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY', 'readinessCode', COALESCE(v_readiness->>'resultCode', 'READINESS_UNAVAILABLE'));
  END IF;
  IF v_readiness->>'confirmedPreviewId' <> v_attempt.confirmed_preview_id::text
    OR (v_readiness->>'confirmedAt')::timestamptz IS DISTINCT FROM v_attempt.confirmed_at
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_EVIDENCE'); END IF;

  SELECT p.status INTO v_project_status FROM public.projects p WHERE p.id = v_attempt.project_id FOR UPDATE;
  IF v_project_status <> 'approved' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY', 'readinessCode', 'INVALID_PROJECT_STATE'); END IF;

  PERFORM pg_catalog.set_config('app.publication_attempt_id', v_attempt.id::text, true);
  FOR v_media IN SELECT value FROM pg_catalog.jsonb_array_elements(v_attempt.media_manifest) LOOP
    UPDATE public.media_assets
       SET public_url = v_media->>'publicUrl',
           public_storage_bucket = v_media->>'publicBucket',
           public_storage_path = v_media->>'publicPath',
           is_public_approved = true
     WHERE id = (v_media->>'mediaAssetId')::uuid
       AND project_id = v_attempt.project_id
       AND storage_bucket = v_media->>'sourceBucket'
       AND storage_path = v_media->>'sourcePath'
       AND is_public_approved = false
       AND public_url IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PUBLICATION_MEDIA_BINDING_MISMATCH'; END IF;
  END LOOP;

  SELECT elem->>'publicUrl' INTO v_poster_url FROM pg_catalog.jsonb_array_elements(v_attempt.media_manifest) elem WHERE elem->>'assetType' = 'poster_image';
  SELECT elem->>'publicUrl' INTO v_poster_pdf_url FROM pg_catalog.jsonb_array_elements(v_attempt.media_manifest) elem WHERE elem->>'assetType' = 'poster_pdf';
  SELECT COALESCE(pg_catalog.array_agg(elem->>'publicUrl' ORDER BY elem->>'publicPath'), '{}'::text[])
    INTO v_snapshots FROM pg_catalog.jsonb_array_elements(v_attempt.media_manifest) elem WHERE elem->>'assetType' = 'snapshot_image';

  UPDATE public.projects
     SET status = 'published',
         poster_url = COALESCE(v_poster_url, poster_url),
         poster_pdf_url = COALESCE(v_poster_pdf_url, poster_pdf_url),
         snapshots = CASE WHEN pg_catalog.jsonb_array_length(v_attempt.media_manifest) > 0 THEN v_snapshots ELSE snapshots END
   WHERE id = v_attempt.project_id AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLICATION_PROJECT_STATE_CHANGED'; END IF;

  INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments)
  VALUES (v_attempt.project_id, v_attempt.admin_id, 'publish', 'approved', 'published', 'Controlled publication execution')
  RETURNING id INTO v_audit_id;

  INSERT INTO public.published_snapshots(feed_file_name, storage_bucket, storage_path, public_url, record_count, feed_hash, created_by)
  VALUES (pg_catalog.regexp_replace(v_attempt.feed_storage_path, '^.*/', ''), v_attempt.feed_storage_bucket,
    v_attempt.feed_storage_bucket || '/' || v_attempt.feed_storage_path, v_attempt.feed_public_url,
    v_attempt.candidate_record_count, v_attempt.candidate_feed_hash, v_attempt.admin_id)
  RETURNING id INTO v_snapshot_id;

  UPDATE public.publication_attempts
     SET state = 'completed', published_snapshot_id = v_snapshot_id, publish_audit_record_id = v_audit_id,
         completed_at = pg_catalog.now(), updated_at = pg_catalog.now(), lease_expires_at = pg_catalog.now()
   WHERE id = v_attempt.id;

  RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPLETED', 'attemptId', v_attempt.id::text,
    'snapshotId', v_snapshot_id::text, 'auditRecordId', v_audit_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_publication_attempt(
  p_attempt_id uuid, p_execution_token uuid, p_failure_code text, p_compensation_failure_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_attempt public.publication_attempts%ROWTYPE; v_failure text; v_compensation text;
BEGIN
  v_failure := pg_catalog.btrim(COALESCE(p_failure_code, ''));
  v_compensation := NULLIF(pg_catalog.btrim(COALESCE(p_compensation_failure_code, '')), '');
  IF v_failure !~ '^[A-Z0-9_]{1,64}$' OR (v_compensation IS NOT NULL AND v_compensation !~ '^[A-Z0-9_]{1,64}$')
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.publication_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_TOKEN_MISMATCH'); END IF;
  IF v_attempt.state = 'completed' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_COMPLETED'); END IF;
  UPDATE public.publication_attempts
     SET state = CASE WHEN v_compensation IS NULL THEN 'failed' ELSE 'compensation_failed' END,
         failure_code = v_failure, compensation_failure_code = v_compensation,
         failed_at = pg_catalog.now(), updated_at = pg_catalog.now(), lease_expires_at = pg_catalog.now()
   WHERE id = p_attempt_id;
  RETURN pg_catalog.jsonb_build_object('resultCode', CASE WHEN v_compensation IS NULL THEN 'FAILED' ELSE 'COMPENSATION_INCOMPLETE' END, 'attemptId', p_attempt_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_public_media_mapping() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_active_publication_attempt() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_publication_attempt(text,uuid,text,uuid,timestamptz,integer,text,text,text,text,text,boolean,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_publication_attempt(text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_publication_attempt_storage_written(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_publication_attempt(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_publication_attempt(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_publication_attempt(text,uuid,text,uuid,timestamptz,integer,text,text,text,text,text,boolean,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_publication_attempt(text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_publication_attempt_storage_written(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_publication_attempt(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_publication_attempt(uuid,uuid,text,text) TO service_role;

COMMIT;
