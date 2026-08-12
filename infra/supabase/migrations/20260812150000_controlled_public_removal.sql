-- Migration 0020: controlled Local public-feed removal and archive convergence.
BEGIN;

CREATE TABLE public.public_removal_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  public_id text NOT NULL,
  admin_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  archive_reason text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(archive_reason)) BETWEEN 1 AND 4000),
  candidate_record_count integer CHECK (candidate_record_count IS NULL OR candidate_record_count >= 0),
  candidate_feed_hash text CHECK (candidate_feed_hash IS NULL OR candidate_feed_hash ~ '^[0-9a-f]{64}$'),
  candidate_feed_content text,
  feed_storage_bucket text CHECK (feed_storage_bucket IS NULL OR pg_catalog.btrim(feed_storage_bucket) <> ''),
  feed_storage_path text CHECK (feed_storage_path IS NULL OR pg_catalog.btrim(feed_storage_path) <> ''),
  feed_public_url text CHECK (feed_public_url IS NULL OR pg_catalog.btrim(feed_public_url) <> ''),
  previous_feed_existed boolean,
  previous_feed_content text,
  artifact_bound_at timestamptz,
  state text NOT NULL CHECK (state IN ('reserved', 'prepared', 'storage_written', 'completed', 'failed', 'compensation_failed')),
  execution_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at timestamptz NOT NULL,
  storage_verified_at timestamptz,
  archive_audit_record_id uuid REFERENCES public.approval_records(id) ON DELETE SET NULL,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'),
  compensation_failure_code text CHECK (compensation_failure_code IS NULL OR compensation_failure_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT public_removal_previous_feed_coherent CHECK (
    (artifact_bound_at IS NULL AND previous_feed_existed IS NULL AND previous_feed_content IS NULL)
    OR (previous_feed_existed = true AND previous_feed_content IS NOT NULL)
    OR (previous_feed_existed = false AND previous_feed_content IS NULL)
  ),
  CONSTRAINT public_removal_artifact_binding_coherent CHECK (
    (artifact_bound_at IS NULL AND candidate_record_count IS NULL AND candidate_feed_hash IS NULL AND candidate_feed_content IS NULL
      AND feed_storage_bucket IS NULL AND feed_storage_path IS NULL AND feed_public_url IS NULL AND previous_feed_existed IS NULL)
    OR (artifact_bound_at IS NOT NULL AND candidate_record_count IS NOT NULL AND candidate_feed_hash IS NOT NULL AND candidate_feed_content IS NOT NULL
      AND feed_storage_bucket IS NOT NULL AND feed_storage_path IS NOT NULL AND feed_public_url IS NOT NULL AND previous_feed_existed IS NOT NULL)
  ),
  CONSTRAINT public_removal_state_binding_coherent CHECK (
    (state = 'reserved' AND artifact_bound_at IS NULL)
    OR (state IN ('prepared', 'storage_written', 'completed') AND artifact_bound_at IS NOT NULL)
    OR state IN ('failed', 'compensation_failed')
  ),
  CONSTRAINT public_removal_storage_evidence_coherent CHECK (
    (state IN ('storage_written', 'completed') AND storage_verified_at IS NOT NULL)
    OR state IN ('reserved', 'prepared', 'failed', 'compensation_failed')
  ),
  CONSTRAINT public_removal_terminal_state_coherent CHECK (
    (state = 'completed' AND completed_at IS NOT NULL AND archive_audit_record_id IS NOT NULL AND failure_code IS NULL)
    OR (state IN ('failed', 'compensation_failed') AND failed_at IS NOT NULL AND failure_code IS NOT NULL AND completed_at IS NULL AND archive_audit_record_id IS NULL)
    OR (state IN ('reserved', 'prepared', 'storage_written') AND completed_at IS NULL AND failed_at IS NULL AND archive_audit_record_id IS NULL AND failure_code IS NULL)
  )
);

CREATE INDEX public_removal_attempts_project_idx ON public.public_removal_attempts(project_id);
CREATE UNIQUE INDEX public_removal_one_active_global_idx ON public.public_removal_attempts ((true))
  WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed');
CREATE UNIQUE INDEX public_removal_one_completed_project_idx ON public.public_removal_attempts(project_id) WHERE state = 'completed';

ALTER TABLE public.public_removal_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_all_public_removal_attempts ON public.public_removal_attempts FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL PRIVILEGES ON TABLE public.public_removal_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.public_removal_attempts TO service_role;

-- Forward-hardening: generic review archive may never remove an already-public project.
CREATE OR REPLACE FUNCTION public.perform_project_review_action(p_public_id text, p_action text, p_comments text, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text; v_comments text; v_roles text[]; v_project_id uuid; v_from_status text;
  v_to_status text; v_archive_reason text; v_now timestamptz; v_audit_record_id uuid;
  v_unresolved integer; v_active integer;
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
  SELECT p.id, p.status INTO v_project_id, v_from_status FROM public.projects p WHERE p.public_id = v_public_id AND p.deleted_at IS NULL FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.reserve_public_removal_attempt(p_public_id text, p_admin_id uuid, p_archive_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, '')); v_reason text := pg_catalog.btrim(COALESCE(p_archive_reason, ''));
  v_roles text[]; v_project_id uuid; v_existing public.public_removal_attempts%ROWTYPE; v_attempt public.public_removal_attempts%ROWTYPE; v_state text;
BEGIN
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' OR p_admin_id IS NULL OR v_reason = '' OR pg_catalog.length(v_reason) > 4000 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  SELECT pg_catalog.array_agg(ur.role) INTO v_roles FROM public.user_roles ur WHERE ur.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT state INTO v_state FROM public.publication_attempts WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_state IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', CASE WHEN v_state = 'compensation_failed' THEN 'COMPENSATION_INCOMPLETE' ELSE 'PUBLICATION_IN_PROGRESS' END); END IF;
  SELECT * INTO v_existing FROM public.public_removal_attempts WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', CASE WHEN v_existing.state = 'compensation_failed' THEN 'COMPENSATION_INCOMPLETE' ELSE 'PUBLICATION_IN_PROGRESS' END); END IF;
  SELECT * INTO v_existing FROM public.public_removal_attempts WHERE public_id = v_public_id AND state = 'completed' ORDER BY completed_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_COMPLETED', 'attemptId', v_existing.id::text); END IF;
  SELECT id INTO v_project_id FROM public.projects WHERE public_id = v_public_id AND deleted_at IS NULL AND status = 'published' FOR UPDATE;
  IF v_project_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_PUBLISHED'); END IF;
  INSERT INTO public.public_removal_attempts(project_id, public_id, admin_id, archive_reason, state, lease_expires_at)
  VALUES (v_project_id, v_public_id, p_admin_id, v_reason, 'reserved', pg_catalog.now() + interval '5 minutes') RETURNING * INTO v_attempt;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_RESERVED', 'attemptId', v_attempt.id::text, 'executionToken', v_attempt.execution_token::text);
END; $$;

CREATE OR REPLACE FUNCTION public.prepare_public_removal_attempt(p_attempt_id uuid, p_execution_token uuid, p_candidate_record_count integer, p_candidate_feed_hash text, p_candidate_feed_content text, p_feed_storage_bucket text, p_feed_storage_path text, p_feed_public_url text, p_previous_feed_existed boolean, p_previous_feed_content text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_attempt public.public_removal_attempts%ROWTYPE; v_candidate jsonb; v_status text;
BEGIN
  IF p_attempt_id IS NULL OR p_execution_token IS NULL OR p_candidate_record_count IS NULL OR p_candidate_record_count < 0 OR p_candidate_feed_hash !~ '^[0-9a-f]{64}$' OR p_candidate_feed_content IS NULL OR pg_catalog.octet_length(p_candidate_feed_content) > 10485760 OR pg_catalog.btrim(COALESCE(p_feed_storage_bucket, '')) = '' OR pg_catalog.btrim(COALESCE(p_feed_storage_path, '')) = '' OR pg_catalog.btrim(COALESCE(p_feed_public_url, '')) = '' OR p_previous_feed_existed IS DISTINCT FROM true OR p_previous_feed_content IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  BEGIN v_candidate := p_candidate_feed_content::jsonb; EXCEPTION WHEN others THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT'); END;
  IF pg_catalog.jsonb_typeof(v_candidate) <> 'array' OR pg_catalog.jsonb_array_length(v_candidate) <> p_candidate_record_count OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_candidate_feed_content, 'UTF8'), 'sha256'), 'hex') <> p_candidate_feed_hash THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.public_removal_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_TOKEN_MISMATCH'); END IF;
  IF v_attempt.state <> 'reserved' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ATTEMPT_STATE'); END IF;
  SELECT status INTO v_status FROM public.projects WHERE id = v_attempt.project_id AND deleted_at IS NULL;
  IF v_status IS DISTINCT FROM 'published' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_PUBLISHED'); END IF;
  UPDATE public.public_removal_attempts SET candidate_record_count = p_candidate_record_count, candidate_feed_hash = p_candidate_feed_hash, candidate_feed_content = p_candidate_feed_content, feed_storage_bucket = p_feed_storage_bucket, feed_storage_path = p_feed_storage_path, feed_public_url = p_feed_public_url, previous_feed_existed = true, previous_feed_content = p_previous_feed_content, artifact_bound_at = pg_catalog.now(), state = 'prepared', updated_at = pg_catalog.now(), lease_expires_at = pg_catalog.now() + interval '5 minutes' WHERE id = v_attempt.id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_BOUND', 'attemptId', v_attempt.id::text);
END; $$;

CREATE OR REPLACE FUNCTION public.claim_public_removal_attempt(p_public_id text, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_roles text[]; v_attempt public.public_removal_attempts%ROWTYPE;
BEGIN
  SELECT pg_catalog.array_agg(ur.role) INTO v_roles FROM public.user_roles ur WHERE ur.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.public_removal_attempts WHERE public_id = pg_catalog.btrim(COALESCE(p_public_id, '')) AND state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed') ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.state = 'compensation_failed' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPENSATION_INCOMPLETE'); END IF;
  IF v_attempt.admin_id IS DISTINCT FROM p_admin_id THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_OWNER_MISMATCH'); END IF;
  IF v_attempt.lease_expires_at > pg_catalog.now() THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLICATION_IN_PROGRESS'); END IF;
  UPDATE public.public_removal_attempts SET execution_token = gen_random_uuid(), lease_expires_at = pg_catalog.now() + interval '5 minutes', updated_at = pg_catalog.now() WHERE id = v_attempt.id RETURNING * INTO v_attempt;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_CLAIMED', 'attemptId', v_attempt.id::text, 'executionToken', v_attempt.execution_token::text);
END; $$;

CREATE OR REPLACE FUNCTION public.mark_public_removal_storage_written(p_attempt_id uuid, p_execution_token uuid, p_verified_feed_hash text, p_verified_record_count integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_attempt public.public_removal_attempts%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.public_removal_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_TOKEN_MISMATCH'); END IF;
  IF v_attempt.state NOT IN ('prepared', 'storage_written') THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ATTEMPT_STATE'); END IF;
  IF v_attempt.candidate_feed_hash IS DISTINCT FROM p_verified_feed_hash OR v_attempt.candidate_record_count IS DISTINCT FROM p_verified_record_count THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;
  UPDATE public.public_removal_attempts SET state = 'storage_written', storage_verified_at = pg_catalog.now(), updated_at = pg_catalog.now() WHERE id = p_attempt_id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'STORAGE_WRITTEN');
END; $$;

CREATE OR REPLACE FUNCTION public.finalize_public_removal_attempt(p_attempt_id uuid, p_execution_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_attempt public.public_removal_attempts%ROWTYPE; v_status text; v_audit uuid; v_expected_count integer; v_candidate jsonb;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.public_removal_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.state = 'completed' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_COMPLETED', 'auditRecordId', v_attempt.archive_audit_record_id::text); END IF;
  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_TOKEN_MISMATCH'); END IF;
  IF v_attempt.state <> 'storage_written' OR v_attempt.storage_verified_at IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ATTEMPT_STATE'); END IF;
  SELECT status INTO v_status FROM public.projects WHERE id = v_attempt.project_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'published' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_PUBLISHED'); END IF;
  SELECT pg_catalog.count(*)::integer INTO v_expected_count FROM public.projects WHERE deleted_at IS NULL AND status = 'published' AND id <> v_attempt.project_id;
  IF v_expected_count IS DISTINCT FROM v_attempt.candidate_record_count THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;
  BEGIN v_candidate := v_attempt.candidate_feed_content::jsonb; EXCEPTION WHEN others THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END;
  IF pg_catalog.jsonb_typeof(v_candidate) <> 'array'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) item WHERE pg_catalog.jsonb_typeof(item) <> 'object' OR NULLIF(item->>'publicId', '') IS NULL)
     OR (SELECT pg_catalog.count(DISTINCT item->>'publicId') FROM pg_catalog.jsonb_array_elements(v_candidate) item) IS DISTINCT FROM v_expected_count
     OR EXISTS (
       SELECT p.public_id FROM public.projects p WHERE p.deleted_at IS NULL AND p.status = 'published' AND p.id <> v_attempt.project_id
       EXCEPT SELECT item->>'publicId' FROM pg_catalog.jsonb_array_elements(v_candidate) item
     )
     OR EXISTS (
       SELECT item->>'publicId' FROM pg_catalog.jsonb_array_elements(v_candidate) item
       EXCEPT SELECT p.public_id FROM public.projects p WHERE p.deleted_at IS NULL AND p.status = 'published' AND p.id <> v_attempt.project_id
     )
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;
  PERFORM pg_catalog.set_config('app.public_removal_attempt_id', v_attempt.id::text, true);
  UPDATE public.projects SET status = 'archived', archived_at = pg_catalog.now(), archived_from_status = 'published', archive_reason = v_attempt.archive_reason, pending_removal_from_public = true, public_removal_completed_at = NULL WHERE id = v_attempt.project_id AND status = 'published';
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLIC_REMOVAL_PROJECT_STATE_CHANGED'; END IF;
  INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments) VALUES (v_attempt.project_id, v_attempt.admin_id, 'archive', 'published', 'archived', v_attempt.archive_reason) RETURNING id INTO v_audit;
  UPDATE public.public_removal_attempts SET state = 'completed', archive_audit_record_id = v_audit, completed_at = pg_catalog.now(), updated_at = pg_catalog.now(), lease_expires_at = pg_catalog.now() WHERE id = v_attempt.id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPLETED', 'attemptId', v_attempt.id::text, 'auditRecordId', v_audit::text);
END; $$;

CREATE OR REPLACE FUNCTION public.fail_public_removal_attempt(p_attempt_id uuid, p_execution_token uuid, p_failure_code text, p_compensation_failure_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_attempt public.public_removal_attempts%ROWTYPE; v_failure text := pg_catalog.btrim(COALESCE(p_failure_code, '')); v_comp text := NULLIF(pg_catalog.btrim(COALESCE(p_compensation_failure_code, '')), '');
BEGIN
  IF v_failure !~ '^[A-Z0-9_]{1,64}$' OR (v_comp IS NOT NULL AND v_comp !~ '^[A-Z0-9_]{1,64}$') THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT * INTO v_attempt FROM public.public_removal_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_attempt.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_NOT_FOUND'); END IF;
  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_TOKEN_MISMATCH'); END IF;
  IF v_attempt.state = 'completed' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_COMPLETED'); END IF;
  UPDATE public.public_removal_attempts SET state = CASE WHEN v_comp IS NULL THEN 'failed' ELSE 'compensation_failed' END, failure_code = v_failure, compensation_failure_code = v_comp, failed_at = pg_catalog.now(), updated_at = pg_catalog.now(), lease_expires_at = pg_catalog.now() WHERE id = p_attempt_id;
  RETURN pg_catalog.jsonb_build_object('resultCode', CASE WHEN v_comp IS NULL THEN 'FAILED' ELSE 'COMPENSATION_INCOMPLETE' END);
END; $$;

-- Publication and removal mutate one canonical feed and therefore share one durable slot.
CREATE OR REPLACE FUNCTION public.reserve_publication_attempt(p_public_id text, p_admin_id uuid, p_private_bucket text, p_confirmed_preview_id uuid, p_confirmed_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, '')); v_roles text[]; v_readiness jsonb; v_project_id uuid; v_existing public.publication_attempts%ROWTYPE; v_attempt public.publication_attempts%ROWTYPE; v_removal_state text;
BEGIN
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' OR p_admin_id IS NULL OR p_confirmed_preview_id IS NULL OR p_confirmed_at IS NULL OR pg_catalog.btrim(COALESCE(p_private_bucket, '')) = '' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  SELECT pg_catalog.array_agg(ur.role) INTO v_roles FROM public.user_roles ur WHERE ur.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('controlled_publication_global'));
  SELECT state INTO v_removal_state FROM public.public_removal_attempts WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_removal_state IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', CASE WHEN v_removal_state = 'compensation_failed' THEN 'COMPENSATION_INCOMPLETE' ELSE 'PUBLICATION_IN_PROGRESS' END); END IF;
  SELECT * INTO v_existing FROM public.publication_attempts WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', CASE WHEN v_existing.state = 'compensation_failed' THEN 'COMPENSATION_INCOMPLETE' ELSE 'PUBLICATION_IN_PROGRESS' END, 'attemptId', v_existing.id::text); END IF;
  SELECT * INTO v_existing FROM public.publication_attempts WHERE public_id = v_public_id AND state = 'completed' ORDER BY completed_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_COMPLETED', 'attemptId', v_existing.id::text); END IF;
  v_readiness := public.get_project_publication_readiness(v_public_id, p_admin_id, p_private_bucket);
  IF v_readiness->>'resultCode' <> 'READY' OR COALESCE((v_readiness->>'ready')::boolean, false) = false THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY', 'readinessCode', COALESCE(v_readiness->>'resultCode', 'READINESS_UNAVAILABLE')); END IF;
  IF v_readiness->>'confirmedPreviewId' <> p_confirmed_preview_id::text OR (v_readiness->>'confirmedAt')::timestamptz IS DISTINCT FROM p_confirmed_at THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_EVIDENCE'); END IF;
  SELECT p.id INTO v_project_id FROM public.projects p WHERE p.public_id = v_public_id AND p.deleted_at IS NULL AND p.status = 'approved';
  IF v_project_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY', 'readinessCode', 'INVALID_PROJECT_STATE'); END IF;
  INSERT INTO public.publication_attempts(project_id, public_id, admin_id, confirmed_preview_id, confirmed_at, state, lease_expires_at) VALUES (v_project_id, v_public_id, p_admin_id, p_confirmed_preview_id, p_confirmed_at, 'reserved', pg_catalog.now() + interval '5 minutes') RETURNING * INTO v_attempt;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'ATTEMPT_RESERVED', 'attemptId', v_attempt.id::text, 'executionToken', v_attempt.execution_token::text, 'state', v_attempt.state);
END; $$;

REVOKE ALL ON FUNCTION public.reserve_public_removal_attempt(text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_public_removal_attempt(uuid,uuid,integer,text,text,text,text,text,boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_public_removal_attempt(text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_public_removal_storage_written(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_public_removal_attempt(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_public_removal_attempt(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_public_removal_attempt(text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_public_removal_attempt(uuid,uuid,integer,text,text,text,text,text,boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_public_removal_attempt(text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_public_removal_storage_written(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_public_removal_attempt(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_public_removal_attempt(uuid,uuid,text,text) TO service_role;

COMMIT;
