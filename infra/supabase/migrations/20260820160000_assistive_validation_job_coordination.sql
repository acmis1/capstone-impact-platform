-- Migration 0031: durable PostgreSQL coordination for the PP1 assistive-validation worker.
--
-- This remains a non-authoritative side domain. The coordinator may read project title and
-- private poster bytes, but no function or trigger below writes projects, media, approval,
-- publication, or validation-authority state. PostgreSQL is the queue; no external broker exists.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Expand a run from the Phase 3 terminal record into a bounded lifecycle.
-- ---------------------------------------------------------------------------

ALTER TABLE public.assistive_validation_runs
  DROP CONSTRAINT check_assistive_run_status,
  DROP CONSTRAINT check_assistive_run_failure_code,
  DROP CONSTRAINT check_assistive_run_failure_coherence;

ALTER TABLE public.assistive_validation_runs
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz;

UPDATE public.assistive_validation_runs
   SET completed_at = created_at;

ALTER TABLE public.assistive_validation_runs
  ADD CONSTRAINT check_assistive_run_status
    CHECK (status IN (
      'QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'
    )),
  ADD CONSTRAINT check_assistive_run_failure_code
    CHECK (failure_code IS NULL OR failure_code IN (
      'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
      'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
      'DETERMINISTIC_CONTRACT_REJECTED', 'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE',
      'IDENTITY_CONFLICT', 'INTERNAL_FAILURE'
    )),
  ADD CONSTRAINT check_assistive_run_failure_coherence
    CHECK (
      (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'SUPERSEDED')
        AND failure_code IS NULL)
      OR (status = 'PARTIAL'
        AND failure_code IN ('OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE'))
      OR (status = 'FAILED'
        AND failure_code IN (
          'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
          'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
          'DETERMINISTIC_CONTRACT_REJECTED', 'IDENTITY_CONFLICT', 'INTERNAL_FAILURE'
        ))
    ),
  ADD CONSTRAINT check_assistive_run_timestamps
    CHECK (
      (status IN ('QUEUED', 'RUNNING') AND completed_at IS NULL)
      OR (status IN ('PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
          AND completed_at IS NOT NULL)
    );

-- At most one outstanding request for a content identity. Terminal failures and cancellations do
-- not block a later request, while Phase 3's completed-identity index remains unchanged.
CREATE UNIQUE INDEX uq_assistive_validation_runs_active_identity
  ON public.assistive_validation_runs (project_id, input_hash, pipeline_version)
  WHERE status IN ('QUEUED', 'RUNNING');

-- Migration 0030 inserts terminal runs without naming completed_at. Preserve that exact RPC by
-- deriving its new lifecycle timestamp at the row boundary; Phase 4 QUEUED inserts remain null.
CREATE OR REPLACE FUNCTION public.set_assistive_validation_run_terminal_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status IN ('PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
     AND NEW.completed_at IS NULL
  THEN
    NEW.completed_at := NEW.created_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_assistive_validation_run_terminal_timestamp()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER assistive_validation_runs_set_terminal_timestamp
BEFORE INSERT ON public.assistive_validation_runs
FOR EACH ROW EXECUTE FUNCTION public.set_assistive_validation_run_terminal_timestamp();

-- ---------------------------------------------------------------------------
-- 2. Exactly one durable job per run.
-- ---------------------------------------------------------------------------

CREATE TABLE public.assistive_validation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL
    CONSTRAINT assistive_validation_jobs_run_fk
    REFERENCES public.assistive_validation_runs(id) ON DELETE CASCADE,
  status text NOT NULL
    CONSTRAINT check_assistive_job_status
    CHECK (status IN (
      'QUEUED', 'EXTRACTING', 'CHECKING', 'PARTIAL', 'COMPLETED', 'FAILED',
      'CANCELLED', 'SUPERSEDED'
    )),
  attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT check_assistive_job_attempt_count CHECK (attempt_count BETWEEN 0 AND 2),
  available_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  claimed_at timestamptz,
  lease_until timestamptz,
  worker_id uuid,
  claim_token uuid,
  cancellation_requested_at timestamptz,
  cancelled_at timestamptz,
  last_error_code text
    CONSTRAINT check_assistive_job_last_error_code
    CHECK (last_error_code IS NULL OR last_error_code IN (
      'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
      'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
      'DETERMINISTIC_CONTRACT_REJECTED', 'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE',
      'IDENTITY_CONFLICT', 'INTERNAL_FAILURE'
    )),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT uq_assistive_validation_jobs_run UNIQUE (run_id),
  CONSTRAINT check_assistive_job_claim_coherence CHECK (
    (status IN ('EXTRACTING', 'CHECKING')
      AND claimed_at IS NOT NULL AND lease_until IS NOT NULL
      AND worker_id IS NOT NULL AND claim_token IS NOT NULL AND attempt_count BETWEEN 1 AND 2)
    OR (status NOT IN ('EXTRACTING', 'CHECKING')
      AND lease_until IS NULL AND claim_token IS NULL)
  ),
  CONSTRAINT check_assistive_job_cancellation_coherence CHECK (
    (status = 'CANCELLED' AND cancellation_requested_at IS NOT NULL AND cancelled_at IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL)
  )
);

CREATE INDEX idx_assistive_validation_jobs_claim
  ON public.assistive_validation_jobs (available_at, created_at, id)
  WHERE status IN ('QUEUED', 'EXTRACTING', 'CHECKING');

CREATE INDEX idx_assistive_validation_jobs_lease
  ON public.assistive_validation_jobs (lease_until, id)
  WHERE status IN ('EXTRACTING', 'CHECKING');

ALTER TABLE public.assistive_validation_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY deny_assistive_validation_jobs_direct_access
  ON public.assistive_validation_jobs
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.assistive_validation_jobs
  FROM PUBLIC, anon, authenticated, service_role;

-- A Phase 3 caller still inserts a terminal run directly. This trigger supplies its matching
-- terminal job; a Phase 4 enqueue inserts QUEUED and receives a QUEUED job by the same path.
CREATE OR REPLACE FUNCTION public.create_assistive_validation_job_for_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.assistive_validation_jobs (
    run_id,
    status,
    attempt_count,
    available_at,
    last_error_code,
    cancellation_requested_at,
    cancelled_at
  )
  VALUES (
    NEW.id,
    NEW.status,
    0,
    NEW.created_at,
    NEW.failure_code,
    CASE WHEN NEW.status = 'CANCELLED' THEN NEW.completed_at ELSE NULL END,
    CASE WHEN NEW.status = 'CANCELLED' THEN NEW.completed_at ELSE NULL END
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.create_assistive_validation_job_for_run()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER assistive_validation_runs_create_job
AFTER INSERT ON public.assistive_validation_runs
FOR EACH ROW EXECUTE FUNCTION public.create_assistive_validation_job_for_run();

-- The paired rows are allowed to be briefly inconsistent inside one transaction, but never at
-- commit. The check also prevents a service function from orphaning or multiplying jobs.
CREATE OR REPLACE FUNCTION public.check_assistive_validation_run_job_pair()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run_id uuid;
  v_run_status text;
  v_job_status text;
  v_job_count integer;
BEGIN
  IF TG_TABLE_NAME = 'assistive_validation_runs' THEN
    v_run_id := COALESCE(NEW.id, OLD.id);
  ELSE
    v_run_id := COALESCE(NEW.run_id, OLD.run_id);
  END IF;

  SELECT r.status INTO v_run_status
    FROM public.assistive_validation_runs AS r
   WHERE r.id = v_run_id;

  IF NOT FOUND THEN
    -- The job-side cascade of a deleted run is coherent once both rows are absent.
    IF EXISTS (SELECT 1 FROM public.assistive_validation_jobs AS j WHERE j.run_id = v_run_id) THEN
      RAISE EXCEPTION 'assistive job has no run' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.min(j.status)
    INTO v_job_count, v_job_status
    FROM public.assistive_validation_jobs AS j
   WHERE j.run_id = v_run_id;

  IF v_job_count <> 1
     OR NOT (
       (v_run_status = 'QUEUED' AND v_job_status = 'QUEUED')
       OR (v_run_status = 'RUNNING' AND v_job_status IN ('EXTRACTING', 'CHECKING'))
       OR (v_run_status IN ('PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
           AND v_job_status = v_run_status)
     )
  THEN
    RAISE EXCEPTION 'assistive run/job lifecycle mismatch' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.check_assistive_validation_run_job_pair()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER assistive_validation_runs_job_pair
AFTER INSERT OR UPDATE OR DELETE ON public.assistive_validation_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_assistive_validation_run_job_pair();

CREATE CONSTRAINT TRIGGER assistive_validation_jobs_run_pair
AFTER INSERT OR UPDATE OR DELETE ON public.assistive_validation_jobs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_assistive_validation_run_job_pair();

-- Direct table access is denied, but transition guards are defence in depth for every present and
-- future SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.guard_assistive_validation_run_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (
       OLD.status IN ('PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
       OR (OLD.status = 'QUEUED' AND NEW.status NOT IN (
         'RUNNING', 'FAILED', 'CANCELLED', 'SUPERSEDED'
       ))
       OR (OLD.status = 'RUNNING' AND NEW.status NOT IN (
         'QUEUED', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'
       ))
     )
  THEN
    RAISE EXCEPTION 'invalid assistive run transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_assistive_validation_run_transition()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER assistive_validation_runs_guard_transition
BEFORE UPDATE ON public.assistive_validation_runs
FOR EACH ROW EXECUTE FUNCTION public.guard_assistive_validation_run_transition();

CREATE OR REPLACE FUNCTION public.guard_assistive_validation_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status IN ('PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
     OR (OLD.status = 'QUEUED' AND NEW.status NOT IN (
       'QUEUED', 'EXTRACTING', 'FAILED', 'CANCELLED', 'SUPERSEDED'
     ))
     OR (OLD.status = 'EXTRACTING' AND NEW.status NOT IN (
       'QUEUED', 'EXTRACTING', 'CHECKING', 'PARTIAL', 'COMPLETED', 'FAILED',
       'CANCELLED', 'SUPERSEDED'
     ))
     OR (OLD.status = 'CHECKING' AND NEW.status NOT IN (
       'QUEUED', 'EXTRACTING', 'CHECKING', 'PARTIAL', 'COMPLETED', 'FAILED',
       'CANCELLED', 'SUPERSEDED'
     ))
  THEN
    RAISE EXCEPTION 'invalid assistive job transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_assistive_validation_job_transition()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER assistive_validation_jobs_guard_transition
BEFORE UPDATE ON public.assistive_validation_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_assistive_validation_job_transition();

-- ---------------------------------------------------------------------------
-- 3. Enqueue, status, health, claim, heartbeat, stage, and cancellation RPCs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_assistive_validation_run(
  p_project_id uuid,
  p_actor_admin_id uuid,
  p_input_hash text,
  p_pipeline_version text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_input_hash text := pg_catalog.btrim(COALESCE(p_input_hash, ''));
  v_pipeline_version text := pg_catalog.btrim(COALESCE(p_pipeline_version, ''));
  v_run_id uuid;
  v_status text;
BEGIN
  IF p_project_id IS NULL OR p_actor_admin_id IS NULL
     OR v_input_hash !~ '^[a-f0-9]{64}$'
     OR v_pipeline_version !~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$'
     OR pg_catalog.length(v_pipeline_version) > 64
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users AS u
    JOIN public.user_roles AS ur ON ur.user_id = u.id
    WHERE u.id = p_actor_admin_id AND ur.role IN ('admin', 'reviewer', 'editor')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects AS p
    WHERE p.id = p_project_id AND p.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_project_id::text || ':' || v_input_hash || ':' || v_pipeline_version)
  );

  SELECT r.id, r.status INTO v_run_id, v_status
    FROM public.assistive_validation_runs AS r
   WHERE r.project_id = p_project_id
     AND r.input_hash = v_input_hash
     AND r.pipeline_version = v_pipeline_version
     AND r.status IN ('COMPLETED', 'QUEUED', 'RUNNING')
   ORDER BY CASE r.status WHEN 'COMPLETED' THEN 0 ELSE 1 END, r.created_at, r.id
   LIMIT 1;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', CASE WHEN v_status = 'COMPLETED' THEN 'ALREADY_COMPLETED' ELSE 'ALREADY_QUEUED' END,
      'runId', v_run_id::text,
      'status', v_status
    );
  END IF;

  INSERT INTO public.assistive_validation_runs (
    project_id, requested_by, input_hash, pipeline_version, status, failure_code
  ) VALUES (
    p_project_id, p_actor_admin_id, v_input_hash, v_pipeline_version, 'QUEUED', NULL
  ) RETURNING id INTO v_run_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'ENQUEUED', 'runId', v_run_id::text, 'status', 'QUEUED'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_assistive_validation_run(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_assistive_validation_run(uuid, uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_assistive_validation_run_status(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.jsonb_build_object(
      'resultCode', 'FOUND',
      'runId', r.id::text,
      'projectId', r.project_id::text,
      'inputHash', r.input_hash,
      'pipelineVersion', r.pipeline_version,
      'runStatus', r.status,
      'jobStatus', j.status,
      'attemptCount', j.attempt_count,
      'failureCode', r.failure_code,
      'cancellationRequested', j.cancellation_requested_at IS NOT NULL,
      'createdAt', r.created_at,
      'startedAt', r.started_at,
      'completedAt', r.completed_at
    ) INTO v_result
    FROM public.assistive_validation_runs AS r
    JOIN public.assistive_validation_jobs AS j ON j.run_id = r.id
   WHERE r.id = p_run_id;

  RETURN COALESCE(v_result, pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND'));
END;
$$;

REVOKE ALL ON FUNCTION public.get_assistive_validation_run_status(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_assistive_validation_run_status(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_assistive_validation_job_health()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'resultCode', 'HEALTHY',
    'queuedCount', pg_catalog.count(*) FILTER (WHERE j.status = 'QUEUED'),
    'activeCount', pg_catalog.count(*) FILTER (WHERE j.status IN ('EXTRACTING', 'CHECKING')),
    'expiredLeaseCount', pg_catalog.count(*) FILTER (
      WHERE j.status IN ('EXTRACTING', 'CHECKING') AND j.lease_until <= pg_catalog.now()
    ),
    'cancellationPendingCount', pg_catalog.count(*) FILTER (
      WHERE j.status IN ('EXTRACTING', 'CHECKING') AND j.cancellation_requested_at IS NOT NULL
    ),
    'oldestQueuedAt', pg_catalog.min(j.created_at) FILTER (WHERE j.status = 'QUEUED')
  ) FROM public.assistive_validation_jobs AS j;
$$;

REVOKE ALL ON FUNCTION public.get_assistive_validation_job_health()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_assistive_validation_job_health() TO service_role;

CREATE OR REPLACE FUNCTION public.claim_next_assistive_validation_job(
  p_worker_id uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_token uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lease_seconds integer := COALESCE(p_lease_seconds, 0);
BEGIN
  IF p_worker_id IS NULL OR v_lease_seconds NOT BETWEEN 30 AND 180 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  LOOP
    SELECT j.* INTO v_job
      FROM public.assistive_validation_jobs AS j
     WHERE (j.status = 'QUEUED' AND j.available_at <= v_now)
        OR (j.status IN ('EXTRACTING', 'CHECKING') AND j.lease_until <= v_now)
     ORDER BY j.available_at, j.created_at, j.id
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'EMPTY');
    END IF;

    IF v_job.cancellation_requested_at IS NOT NULL THEN
      UPDATE public.assistive_validation_jobs
         SET status = 'CANCELLED', lease_until = NULL, claim_token = NULL,
             cancelled_at = v_now, updated_at = v_now
       WHERE id = v_job.id;
      UPDATE public.assistive_validation_runs
         SET status = 'CANCELLED', failure_code = NULL, completed_at = v_now
       WHERE id = v_job.run_id;
      CONTINUE;
    END IF;

    IF v_job.attempt_count >= 2 THEN
      UPDATE public.assistive_validation_jobs
         SET status = 'FAILED', lease_until = NULL, claim_token = NULL,
             last_error_code = COALESCE(v_job.last_error_code, 'WORKER_TIMEOUT'),
             updated_at = v_now
       WHERE id = v_job.id;
      UPDATE public.assistive_validation_runs
         SET status = 'FAILED',
             failure_code = COALESCE(v_job.last_error_code, 'WORKER_TIMEOUT'),
             completed_at = v_now
       WHERE id = v_job.run_id;
      CONTINUE;
    END IF;

    v_token := gen_random_uuid();

    UPDATE public.assistive_validation_jobs
       SET status = 'EXTRACTING', attempt_count = attempt_count + 1,
           claimed_at = v_now, lease_until = v_now + pg_catalog.make_interval(secs => v_lease_seconds),
           worker_id = p_worker_id, claim_token = v_token, updated_at = v_now
     WHERE id = v_job.id;

    UPDATE public.assistive_validation_runs
       SET status = 'RUNNING', started_at = COALESCE(started_at, v_now)
     WHERE id = v_job.run_id;

    RETURN (
      SELECT pg_catalog.jsonb_build_object(
        'resultCode', 'CLAIMED',
        'jobId', j.id::text,
        'runId', r.id::text,
        'projectId', r.project_id::text,
        'requestedBy', r.requested_by::text,
        'inputHash', r.input_hash,
        'pipelineVersion', r.pipeline_version,
        'attemptCount', j.attempt_count,
        'claimToken', j.claim_token::text,
        'leaseUntil', j.lease_until
      )
      FROM public.assistive_validation_jobs AS j
      JOIN public.assistive_validation_runs AS r ON r.id = j.run_id
      WHERE j.id = v_job.id
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_assistive_validation_job(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_assistive_validation_job(uuid, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.heartbeat_assistive_validation_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lease_seconds integer := COALESCE(p_lease_seconds, 0);
BEGIN
  IF p_job_id IS NULL OR p_claim_token IS NULL OR v_lease_seconds NOT BETWEEN 30 AND 180 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_job FROM public.assistive_validation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status NOT IN ('EXTRACTING', 'CHECKING')
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_LOST');
  END IF;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'CANCELLED', lease_until = NULL, claim_token = NULL,
           cancelled_at = v_now, updated_at = v_now
     WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'CANCELLED', failure_code = NULL, completed_at = v_now
     WHERE id = v_job.run_id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLED');
  END IF;

  UPDATE public.assistive_validation_jobs
     SET lease_until = v_now + pg_catalog.make_interval(secs => v_lease_seconds), updated_at = v_now
   WHERE id = p_job_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'HEARTBEAT',
    'leaseUntil', v_now + pg_catalog.make_interval(secs => v_lease_seconds)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.heartbeat_assistive_validation_job(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_assistive_validation_job(uuid, uuid, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.advance_assistive_validation_job_stage(
  p_job_id uuid,
  p_claim_token uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_claim_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_job FROM public.assistive_validation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'EXTRACTING'
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_LOST');
  END IF;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'CANCELLED', lease_until = NULL, claim_token = NULL,
           cancelled_at = v_now, updated_at = v_now
     WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'CANCELLED', failure_code = NULL, completed_at = v_now
     WHERE id = v_job.run_id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLED');
  END IF;

  UPDATE public.assistive_validation_jobs
     SET status = 'CHECKING', updated_at = v_now
   WHERE id = p_job_id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'ADVANCED', 'jobStatus', 'CHECKING');
END;
$$;

REVOKE ALL ON FUNCTION public.advance_assistive_validation_job_stage(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.advance_assistive_validation_job_stage(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.request_assistive_validation_cancellation(
  p_run_id uuid,
  p_actor_admin_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_run_id IS NULL OR p_actor_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users AS u
    JOIN public.user_roles AS ur ON ur.user_id = u.id
    WHERE u.id = p_actor_admin_id AND ur.role IN ('admin', 'reviewer', 'editor')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  SELECT j.* INTO v_job
    FROM public.assistive_validation_jobs AS j
   WHERE j.run_id = p_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  IF v_job.status IN ('PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED') THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_TERMINAL', 'jobStatus', v_job.status
    );
  END IF;

  IF v_job.status = 'QUEUED' THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'CANCELLED', cancellation_requested_at = v_now,
           cancelled_at = v_now, updated_at = v_now
     WHERE id = v_job.id;
    UPDATE public.assistive_validation_runs
       SET status = 'CANCELLED', completed_at = v_now
     WHERE id = p_run_id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLED', 'jobStatus', 'CANCELLED');
  END IF;

  UPDATE public.assistive_validation_jobs
     SET cancellation_requested_at = COALESCE(cancellation_requested_at, v_now), updated_at = v_now
   WHERE id = v_job.id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLATION_REQUESTED');
END;
$$;

REVOKE ALL ON FUNCTION public.request_assistive_validation_cancellation(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_assistive_validation_cancellation(uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Fenced terminal mutations.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.supersede_assistive_validation_job(
  p_job_id uuid,
  p_claim_token uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT * INTO v_job FROM public.assistive_validation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status NOT IN ('EXTRACTING', 'CHECKING')
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_LOST');
  END IF;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'CANCELLED', lease_until = NULL, claim_token = NULL,
           cancelled_at = v_now, updated_at = v_now
     WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'CANCELLED', completed_at = v_now
     WHERE id = v_job.run_id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLED');
  END IF;

  UPDATE public.assistive_validation_jobs
     SET status = 'SUPERSEDED', lease_until = NULL, claim_token = NULL, updated_at = v_now
   WHERE id = p_job_id;
  UPDATE public.assistive_validation_runs
     SET status = 'SUPERSEDED', failure_code = NULL, completed_at = v_now
   WHERE id = v_job.run_id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'SUPERSEDED');
END;
$$;

REVOKE ALL ON FUNCTION public.supersede_assistive_validation_job(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supersede_assistive_validation_job(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_assistive_validation_job_failure(
  p_job_id uuid,
  p_claim_token uuid,
  p_failure_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_failure_code text := pg_catalog.btrim(COALESCE(p_failure_code, ''));
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_retryable boolean;
BEGIN
  IF v_failure_code NOT IN (
    'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
    'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
    'DETERMINISTIC_CONTRACT_REJECTED', 'IDENTITY_CONFLICT', 'INTERNAL_FAILURE'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_job FROM public.assistive_validation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status NOT IN ('EXTRACTING', 'CHECKING')
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_LOST');
  END IF;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'CANCELLED', lease_until = NULL, claim_token = NULL,
           cancelled_at = v_now, updated_at = v_now
     WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'CANCELLED', failure_code = NULL, completed_at = v_now
     WHERE id = v_job.run_id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLED');
  END IF;

  v_retryable := v_failure_code IN (
    'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT', 'WORKER_CRASHED',
    'INTERNAL_FAILURE'
  );

  IF v_retryable AND v_job.attempt_count < 2 THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'QUEUED', available_at = v_now + pg_catalog.make_interval(secs => 5 * attempt_count),
           lease_until = NULL, claim_token = NULL, last_error_code = v_failure_code,
           updated_at = v_now
     WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'QUEUED'
     WHERE id = v_job.run_id;
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'RETRY_QUEUED', 'attemptCount', v_job.attempt_count
    );
  END IF;

  UPDATE public.assistive_validation_jobs
     SET status = 'FAILED', lease_until = NULL, claim_token = NULL,
         last_error_code = v_failure_code, updated_at = v_now
   WHERE id = p_job_id;
  UPDATE public.assistive_validation_runs
     SET status = 'FAILED', failure_code = v_failure_code, completed_at = v_now
   WHERE id = v_job.run_id;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'FAILED', 'failureCode', v_failure_code);
END;
$$;

REVOKE ALL ON FUNCTION public.record_assistive_validation_job_failure(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_assistive_validation_job_failure(uuid, uuid, text)
  TO service_role;

-- Strictly validates the closed Phase 3 finding payload before a terminal mutation. It is an
-- internal helper: API roles receive no EXECUTE privilege.
CREATE OR REPLACE FUNCTION public.is_valid_assistive_validation_findings(p_findings jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_finding jsonb;
  v_evidence jsonb;
  v_box jsonb;
  v_finding_keys text[] := ARRAY[
    'checkType', 'outcome', 'classification', 'reasonCode', 'affectedField',
    'origin', 'scoreKind', 'scoreValue', 'evidence'
  ];
  v_evidence_keys text[] := ARRAY[
    'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
    'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'
  ];
BEGIN
  IF p_findings IS NULL OR pg_catalog.jsonb_typeof(p_findings) <> 'array'
     OR pg_catalog.jsonb_array_length(p_findings) NOT BETWEEN 1 AND 50
  THEN
    RETURN false;
  END IF;

  FOR v_finding IN SELECT * FROM pg_catalog.jsonb_array_elements(p_findings) LOOP
    IF pg_catalog.jsonb_typeof(v_finding) <> 'object'
       OR NOT (v_finding ?& v_finding_keys)
       OR (v_finding - v_finding_keys) <> '{}'::jsonb
       OR COALESCE(v_finding ->> 'classification', '') <> 'NON_BLOCKING'
       OR COALESCE(v_finding ->> 'checkType', '') NOT IN (
         'TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION')
       OR COALESCE(v_finding ->> 'outcome', '') NOT IN (
         'AGREES', 'REVIEW', 'MISMATCH', 'NOT_EVALUATED', 'INFORMATION')
       OR COALESCE(v_finding ->> 'reasonCode', '') NOT IN (
         'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
         'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
         'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
         'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
         'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE')
       OR COALESCE(v_finding ->> 'affectedField', '') NOT IN ('title', 'extraction_text')
       OR COALESCE(v_finding ->> 'origin', '') NOT IN (
         'PHASE_1_EXTRACTION', 'DETERMINISTIC_HELPER')
       OR (pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') = 'null')
          <> (pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') = 'null')
    THEN
      RETURN false;
    END IF;

    IF pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') <> 'null' AND (
      v_finding ->> 'scoreKind' <> 'LEXICAL_SIMILARITY'
      OR pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') <> 'number'
      OR pg_catalog.length(v_finding ->> 'scoreValue') > 32
      OR (v_finding ->> 'scoreValue')::numeric NOT BETWEEN 0 AND 1
    ) THEN
      RETURN false;
    END IF;

    v_evidence := v_finding -> 'evidence';
    IF pg_catalog.jsonb_typeof(v_evidence) <> 'object'
       OR COALESCE(v_evidence ->> 'version', '') <> 'assistive-finding-evidence/v1'
       OR pg_catalog.length(v_evidence::text) > 8192
       OR NOT (v_evidence ?& v_evidence_keys)
       OR (v_evidence - v_evidence_keys) <> '{}'::jsonb
       OR pg_catalog.jsonb_typeof(v_evidence -> 'explanation') <> 'string'
       OR pg_catalog.length(v_evidence ->> 'explanation') NOT BETWEEN 1 AND 300
       OR (v_evidence ->> 'explanation') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
       OR pg_catalog.jsonb_typeof(v_evidence -> 'evidenceExcerpt') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'evidenceExcerpt') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'evidenceExcerpt') > 500
             OR (v_evidence ->> 'evidenceExcerpt') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'metadataValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'metadataValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'metadataValue') > 400
             OR (v_evidence ->> 'metadataValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'normalizedMetadataValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'normalizedMetadataValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'normalizedMetadataValue') > 400
             OR (v_evidence ->> 'normalizedMetadataValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'candidateValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'candidateValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'candidateValue') > 400
             OR (v_evidence ->> 'candidateValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'normalizedCandidateValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'normalizedCandidateValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'normalizedCandidateValue') > 400
             OR (v_evidence ->> 'normalizedCandidateValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') NOT IN ('null', 'number')
       OR pg_catalog.jsonb_typeof(v_evidence -> 'boundingBox') NOT IN ('null', 'object')
    THEN
      RETURN false;
    END IF;

    IF pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') = 'number' AND (
      (v_evidence ->> 'pageNumber')::numeric <> pg_catalog.trunc((v_evidence ->> 'pageNumber')::numeric)
      OR (v_evidence ->> 'pageNumber')::numeric NOT BETWEEN 1 AND 10
    ) THEN
      RETURN false;
    END IF;

    v_box := v_evidence -> 'boundingBox';
    IF pg_catalog.jsonb_typeof(v_box) = 'object' AND (
      NOT (v_box ?& ARRAY['left', 'top', 'right', 'bottom', 'unit'])
      OR (v_box - ARRAY['left', 'top', 'right', 'bottom', 'unit']) <> '{}'::jsonb
      OR pg_catalog.jsonb_typeof(v_box -> 'left') <> 'number'
      OR pg_catalog.jsonb_typeof(v_box -> 'top') <> 'number'
      OR pg_catalog.jsonb_typeof(v_box -> 'right') <> 'number'
      OR pg_catalog.jsonb_typeof(v_box -> 'bottom') <> 'number'
      OR v_box ->> 'unit' NOT IN ('PDF_POINTS_TOP_LEFT', 'IMAGE_PIXELS_TOP_LEFT')
      OR (v_box ->> 'right')::numeric < (v_box ->> 'left')::numeric
      OR (v_box ->> 'bottom')::numeric < (v_box ->> 'top')::numeric
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_valid_assistive_validation_findings(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finalize_assistive_validation_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_input_hash text,
  p_status text,
  p_completion_code text,
  p_findings jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_run public.assistive_validation_runs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_status text := pg_catalog.btrim(COALESCE(p_status, ''));
  v_completion_code text := NULLIF(pg_catalog.btrim(COALESCE(p_completion_code, '')), '');
  v_existing_run_id uuid;
  v_existing_findings jsonb;
  v_existing_count integer;
  v_finding_count integer;
BEGIN
  IF p_job_id IS NULL OR p_claim_token IS NULL
     OR COALESCE(p_input_hash, '') !~ '^[a-f0-9]{64}$'
     OR v_status NOT IN ('COMPLETED', 'PARTIAL')
     OR (v_status = 'COMPLETED' AND v_completion_code IS NOT NULL)
     OR (v_status = 'PARTIAL' AND v_completion_code NOT IN (
       'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE'))
     OR NOT public.is_valid_assistive_validation_findings(p_findings)
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_job FROM public.assistive_validation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status NOT IN ('EXTRACTING', 'CHECKING')
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_LOST');
  END IF;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'CANCELLED', lease_until = NULL, claim_token = NULL,
           cancelled_at = v_now, updated_at = v_now
     WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'CANCELLED', failure_code = NULL, completed_at = v_now
     WHERE id = v_job.run_id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLED');
  END IF;

  SELECT * INTO v_run FROM public.assistive_validation_runs WHERE id = v_job.run_id;
  IF p_input_hash IS DISTINCT FROM v_run.input_hash THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INPUT_CHANGED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_run.project_id::text || ':' || v_run.input_hash || ':' || v_run.pipeline_version)
  );

  SELECT r.id INTO v_existing_run_id
    FROM public.assistive_validation_runs AS r
   WHERE r.project_id = v_run.project_id
     AND r.input_hash = v_run.input_hash
     AND r.pipeline_version = v_run.pipeline_version
     AND r.status = 'COMPLETED'
     AND r.id <> v_run.id;

  IF FOUND THEN
    SELECT pg_catalog.count(*), COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'checkType', f.check_type, 'outcome', f.outcome, 'classification', f.classification,
        'reasonCode', f.reason_code, 'affectedField', f.affected_field, 'origin', f.origin,
        'scoreKind', f.score_kind, 'scoreValue', f.score_value, 'evidence', f.evidence
      ) ORDER BY f.ordinal
    ), '[]'::jsonb)
    INTO v_existing_count, v_existing_findings
    FROM public.assistive_validation_findings AS f
    WHERE f.run_id = v_existing_run_id;

    IF v_status = 'COMPLETED' AND v_existing_findings IS NOT DISTINCT FROM p_findings THEN
      UPDATE public.assistive_validation_jobs
         SET status = 'SUPERSEDED', lease_until = NULL, claim_token = NULL, updated_at = v_now
       WHERE id = p_job_id;
      UPDATE public.assistive_validation_runs
         SET status = 'SUPERSEDED', failure_code = NULL, completed_at = v_now
       WHERE id = v_run.id;
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'ALREADY_COMPLETED', 'runId', v_existing_run_id::text,
        'status', 'COMPLETED', 'findingCount', v_existing_count
      );
    END IF;

    UPDATE public.assistive_validation_jobs
       SET status = 'FAILED', lease_until = NULL, claim_token = NULL,
           last_error_code = 'IDENTITY_CONFLICT', updated_at = v_now
     WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'FAILED', failure_code = 'IDENTITY_CONFLICT', completed_at = v_now
     WHERE id = v_run.id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'IDENTITY_CONFLICT');
  END IF;

  INSERT INTO public.assistive_validation_findings (
    run_id, check_type, outcome, classification, reason_code, affected_field, origin,
    ordinal, score_kind, score_value, evidence
  )
  SELECT
    v_run.id,
    element.value ->> 'checkType',
    element.value ->> 'outcome',
    'NON_BLOCKING',
    element.value ->> 'reasonCode',
    element.value ->> 'affectedField',
    element.value ->> 'origin',
    element.position::integer,
    element.value ->> 'scoreKind',
    CASE WHEN pg_catalog.jsonb_typeof(element.value -> 'scoreValue') = 'number'
      THEN (element.value ->> 'scoreValue')::numeric ELSE NULL END,
    element.value -> 'evidence'
  FROM pg_catalog.jsonb_array_elements(p_findings) WITH ORDINALITY AS element(value, position);

  v_finding_count := pg_catalog.jsonb_array_length(p_findings);
  UPDATE public.assistive_validation_jobs
     SET status = v_status, lease_until = NULL, claim_token = NULL,
         last_error_code = v_completion_code, updated_at = v_now
   WHERE id = p_job_id;
  UPDATE public.assistive_validation_runs
     SET status = v_status, failure_code = v_completion_code, completed_at = v_now
   WHERE id = v_run.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'FINALIZED', 'runId', v_run.id::text,
    'status', v_status, 'findingCount', v_finding_count
  );
EXCEPTION WHEN check_violation OR data_exception THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_assistive_validation_job(uuid, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_assistive_validation_job(uuid, uuid, text, text, text, jsonb)
  TO service_role;

-- Preserve the Phase 3 read contract: a newly queued Phase 4 request must not hide the latest
-- terminal Phase 3-compatible result. PARTIAL becomes visible only through the Phase 4 status RPC.
CREATE OR REPLACE FUNCTION public.get_latest_assistive_validation_run(
  p_project_id uuid,
  p_pipeline_version text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pipeline_version text := pg_catalog.btrim(COALESCE(p_pipeline_version, ''));
  v_run public.assistive_validation_runs%ROWTYPE;
  v_findings jsonb;
BEGIN
  IF p_project_id IS NULL
     OR v_pipeline_version !~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$'
     OR pg_catalog.length(v_pipeline_version) > 64
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT r.* INTO v_run
    FROM public.assistive_validation_runs AS r
   WHERE r.project_id = p_project_id
     AND r.pipeline_version = v_pipeline_version
     AND (
       r.status = 'COMPLETED'
       OR (r.status = 'FAILED' AND r.failure_code IN (
         'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED', 'INTERNAL_FAILURE'
       ))
     )
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'findingId', f.id::text, 'ordinal', f.ordinal, 'checkType', f.check_type,
      'outcome', f.outcome, 'classification', f.classification, 'reasonCode', f.reason_code,
      'affectedField', f.affected_field, 'origin', f.origin, 'scoreKind', f.score_kind,
      'scoreValue', f.score_value, 'evidence', f.evidence, 'disposition', f.disposition,
      'reviewedBy', f.reviewed_by::text, 'reviewedAt', f.reviewed_at, 'createdAt', f.created_at
    ) ORDER BY f.ordinal
  ), '[]'::jsonb) INTO v_findings
  FROM public.assistive_validation_findings AS f WHERE f.run_id = v_run.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'FOUND',
    'run', pg_catalog.jsonb_build_object(
      'runId', v_run.id::text, 'projectId', v_run.project_id::text,
      'inputHash', v_run.input_hash, 'pipelineVersion', v_run.pipeline_version,
      'status', v_run.status, 'failureCode', v_run.failure_code, 'createdAt', v_run.created_at
    ),
    'findings', v_findings
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_latest_assistive_validation_run(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_latest_assistive_validation_run(uuid, text)
  TO service_role;

COMMIT;
