-- Carry exact hosted runtime identity through assistive worker heartbeat evidence.
-- Existing heartbeat rows are preserved and worker instance IDs cannot be relabelled across environments.

BEGIN;

ALTER TABLE public.assistive_worker_heartbeats
  DROP CONSTRAINT check_assistive_worker_environment;

ALTER TABLE public.assistive_worker_heartbeats
  ADD CONSTRAINT check_assistive_worker_environment
    CHECK (environment IN ('staging', 'production'));

CREATE OR REPLACE FUNCTION public.upsert_assistive_worker_heartbeat(
  p_worker_instance_id text,
  p_environment text,
  p_pipeline_version text,
  p_deployment_version text,
  p_ocr_capability text,
  p_language_capability text,
  p_health_state text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE(p_worker_instance_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_environment IS NULL
     OR p_environment NOT IN ('staging', 'production')
     OR p_pipeline_version IS DISTINCT FROM 'assistive-deterministic-checks/v3'
     OR COALESCE(p_deployment_version, '') !~ '^[a-f0-9]{40}$'
     OR p_ocr_capability IS DISTINCT FROM 'paddle-title/pp-ocrv6-small@3.7.0'
     OR p_language_capability IS DISTINCT FROM 'languagetool/en-au@6.6'
     OR p_health_state IS NULL
     OR p_health_state NOT IN ('READY', 'STOPPING')
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- A provider instance ID is one immutable environment identity. Never relabel an existing row.
  IF EXISTS (
    SELECT 1
      FROM public.assistive_worker_heartbeats
     WHERE worker_instance_id = p_worker_instance_id
       AND environment <> p_environment
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  INSERT INTO public.assistive_worker_heartbeats AS current_heartbeat (
    worker_instance_id, environment, pipeline_version, deployment_version,
    ocr_capability, language_capability, health_state, heartbeat_at
  ) VALUES (
    p_worker_instance_id, p_environment, p_pipeline_version, p_deployment_version,
    p_ocr_capability, p_language_capability, p_health_state, v_now
  )
  ON CONFLICT (worker_instance_id) DO UPDATE SET
    pipeline_version = EXCLUDED.pipeline_version,
    deployment_version = EXCLUDED.deployment_version,
    ocr_capability = EXCLUDED.ocr_capability,
    language_capability = EXCLUDED.language_capability,
    health_state = EXCLUDED.health_state,
    heartbeat_at = EXCLUDED.heartbeat_at
  WHERE current_heartbeat.environment = EXCLUDED.environment;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- Instance identities change across deploys. Retain only a bounded operational window.
  DELETE FROM public.assistive_worker_heartbeats
   WHERE heartbeat_at < v_now - pg_catalog.make_interval(days => 7);

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'HEARTBEAT_RECORDED',
    'healthState', p_health_state,
    'heartbeatAt', v_now
  );
EXCEPTION WHEN check_violation OR data_exception OR unique_violation THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_assistive_worker_heartbeat(text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_assistive_worker_heartbeat(text, text, text, text, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_assistive_worker_availability(
  p_environment text,
  p_pipeline_version text,
  p_deployment_version text,
  p_ocr_capability text,
  p_language_capability text,
  p_freshness_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_count integer;
  v_latest timestamptz;
BEGIN
  IF p_environment IS NULL
     OR p_environment NOT IN ('staging', 'production')
     OR p_pipeline_version IS DISTINCT FROM 'assistive-deterministic-checks/v3'
     OR COALESCE(p_deployment_version, '') !~ '^[a-f0-9]{40}$'
     OR p_ocr_capability IS DISTINCT FROM 'paddle-title/pp-ocrv6-small@3.7.0'
     OR p_language_capability IS DISTINCT FROM 'languagetool/en-au@6.6'
     OR p_freshness_seconds IS NULL
     OR p_freshness_seconds NOT BETWEEN 30 AND 120
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.count(*)::integer, pg_catalog.max(heartbeat_at)
    INTO v_count, v_latest
    FROM public.assistive_worker_heartbeats
   WHERE environment = p_environment
     AND pipeline_version = p_pipeline_version
     AND deployment_version = p_deployment_version
     AND ocr_capability = p_ocr_capability
     AND language_capability = p_language_capability
     AND health_state = 'READY'
     AND heartbeat_at >= v_now - pg_catalog.make_interval(secs => p_freshness_seconds);

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', CASE WHEN v_count > 0 THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END,
    'compatibleWorkerCount', v_count,
    'latestHeartbeatAt', v_latest
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_assistive_worker_availability(text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_assistive_worker_availability(text, text, text, text, text, integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT '20260910120200_assistive_worker_production_identity|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()
  TO service_role;

COMMIT;
