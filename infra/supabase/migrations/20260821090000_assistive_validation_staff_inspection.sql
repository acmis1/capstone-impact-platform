-- Migration 0032: bounded read-only inspection for staff assistive validation review.
--
-- Phase 5 of PP1 assistive validation provides the staff-facing review interface. This migration
-- is strictly ADDITIVE and READ-ONLY. It introduces one SECURITY DEFINER inspection RPC granted to
-- service_role alone, allowing authenticated server actions to load a project's latest or selected
-- assistive run, active job lifecycle state, and bounded findings in a single query.
--
-- Access model: direct table access remains denied (deny-all RLS + zero table grants on
-- assistive_validation_runs, assistive_validation_jobs, and assistive_validation_findings).
--
-- Security & isolation invariants:
-- 1. Explicit search_path = '' and fully-qualified pg_catalog references.
-- 2. Project ownership check: if p_run_id is provided but belongs to a different project, it fails
--    closed and returns NOT_FOUND.
-- 3. Bounded output: only non-sensitive evidence and lifecycle status are returned. Claim tokens,
--    worker IDs, lease timestamps, private bucket names, internal storage paths, and reviewer identity
--    UUIDs (reviewed_by) are never returned. Finding count is strictly bounded to <= 50.
-- 4. No fabricated job state: exactly one job must exist per run (Migration 31 invariant); if the job
--    row is missing or finding count exceeds bounds, it fails closed with INVARIANT_VIOLATION.
-- 5. No mutations: this function performs zero writes to projects, workflow, media, or findings.
-- 6. No fabricated failure state: failureCode is reported from the run alone. Migration 31 writes
--    assistive_validation_runs.failure_code and assistive_validation_jobs.last_error_code together on
--    every terminal transition, but a retryable failure re-queues the run with a NULL failure_code
--    while the job retains last_error_code. Coalescing the two would therefore report a failure code
--    for a healthy in-flight retry, contradicting check_assistive_run_failure_coherence. Run status
--    is the authority; attempt telemetry stays inside job coordination.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_project_assistive_validation_inspection(
  p_project_id uuid,
  p_pipeline_version text,
  p_run_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pipeline_version text := pg_catalog.btrim(COALESCE(p_pipeline_version, ''));
  v_run public.assistive_validation_runs%ROWTYPE;
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_finding_count integer;
  v_findings jsonb;
BEGIN
  IF p_project_id IS NULL
     OR v_pipeline_version !~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$'
     OR pg_catalog.length(v_pipeline_version) > 64
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF p_run_id IS NOT NULL THEN
    SELECT r.* INTO v_run
      FROM public.assistive_validation_runs AS r
     WHERE r.id = p_run_id
       AND r.project_id = p_project_id
       AND r.pipeline_version = v_pipeline_version;
  ELSE
    SELECT r.* INTO v_run
      FROM public.assistive_validation_runs AS r
     WHERE r.project_id = p_project_id
       AND r.pipeline_version = v_pipeline_version
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  SELECT j.* INTO v_job
    FROM public.assistive_validation_jobs AS j
   WHERE j.run_id = v_run.id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVARIANT_VIOLATION');
  END IF;

  SELECT pg_catalog.count(*) INTO v_finding_count
    FROM public.assistive_validation_findings AS f
   WHERE f.run_id = v_run.id;

  IF v_finding_count > 50 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVARIANT_VIOLATION');
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'findingId', f.id::text,
      'ordinal', f.ordinal,
      'checkType', f.check_type,
      'outcome', f.outcome,
      'classification', f.classification,
      'reasonCode', f.reason_code,
      'affectedField', f.affected_field,
      'origin', f.origin,
      'scoreKind', f.score_kind,
      'scoreValue', f.score_value,
      'evidence', f.evidence,
      'disposition', f.disposition,
      'reviewedAt', f.reviewed_at,
      'createdAt', f.created_at
    ) ORDER BY f.ordinal
  ), '[]'::jsonb) INTO v_findings
  FROM public.assistive_validation_findings AS f
  WHERE f.run_id = v_run.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'FOUND',
    'run', pg_catalog.jsonb_build_object(
      'runId', v_run.id::text,
      'projectId', v_run.project_id::text,
      'inputHash', v_run.input_hash,
      'pipelineVersion', v_run.pipeline_version,
      'runStatus', v_run.status,
      'jobStatus', v_job.status,
      'attemptCount', v_job.attempt_count,
      'failureCode', v_run.failure_code,
      'cancellationRequested', (v_job.cancellation_requested_at IS NOT NULL),
      'createdAt', v_run.created_at,
      'startedAt', v_run.started_at,
      'completedAt', v_run.completed_at
    ),
    'findings', v_findings
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_project_assistive_validation_inspection(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_project_assistive_validation_inspection(uuid, text, uuid)
  TO service_role;

COMMIT;
