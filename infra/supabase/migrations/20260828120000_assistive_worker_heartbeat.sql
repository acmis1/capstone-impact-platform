-- Record bounded liveness evidence for the dedicated staging assistive worker.
-- This migration cannot change projects, workflow, review, publication, or public-feed state.

BEGIN;

CREATE TABLE public.assistive_worker_heartbeats (
  worker_instance_id text PRIMARY KEY,
  environment text NOT NULL,
  pipeline_version text NOT NULL,
  deployment_version text NOT NULL,
  ocr_capability text NOT NULL,
  language_capability text NOT NULL,
  health_state text NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  CONSTRAINT check_assistive_worker_instance_id
    CHECK (worker_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT check_assistive_worker_environment
    CHECK (environment = 'staging'),
  CONSTRAINT check_assistive_worker_pipeline_version
    CHECK (pipeline_version = 'assistive-deterministic-checks/v3'),
  CONSTRAINT check_assistive_worker_deployment_version
    CHECK (deployment_version ~ '^[a-f0-9]{40}$'),
  CONSTRAINT check_assistive_worker_ocr_capability
    CHECK (ocr_capability = 'paddle-title/pp-ocrv6-small@3.7.0'),
  CONSTRAINT check_assistive_worker_language_capability
    CHECK (language_capability = 'languagetool/en-au@6.6'),
  CONSTRAINT check_assistive_worker_health_state
    CHECK (health_state IN ('READY', 'STOPPING'))
);

CREATE INDEX assistive_worker_heartbeats_compatibility_idx
  ON public.assistive_worker_heartbeats (
    environment, pipeline_version, deployment_version,
    ocr_capability, language_capability, heartbeat_at DESC
  )
  WHERE health_state = 'READY';

ALTER TABLE public.assistive_worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistive_worker_heartbeats FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.assistive_worker_heartbeats
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.upsert_assistive_worker_heartbeat(
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
     OR p_environment IS DISTINCT FROM 'staging'
     OR p_pipeline_version IS DISTINCT FROM 'assistive-deterministic-checks/v3'
     OR COALESCE(p_deployment_version, '') !~ '^[a-f0-9]{40}$'
     OR p_ocr_capability IS DISTINCT FROM 'paddle-title/pp-ocrv6-small@3.7.0'
     OR p_language_capability IS DISTINCT FROM 'languagetool/en-au@6.6'
     OR p_health_state IS NULL
     OR p_health_state NOT IN ('READY', 'STOPPING')
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  INSERT INTO public.assistive_worker_heartbeats (
    worker_instance_id, environment, pipeline_version, deployment_version,
    ocr_capability, language_capability, health_state, heartbeat_at
  ) VALUES (
    p_worker_instance_id, p_environment, p_pipeline_version, p_deployment_version,
    p_ocr_capability, p_language_capability, p_health_state, v_now
  )
  ON CONFLICT (worker_instance_id) DO UPDATE SET
    environment = EXCLUDED.environment,
    pipeline_version = EXCLUDED.pipeline_version,
    deployment_version = EXCLUDED.deployment_version,
    ocr_capability = EXCLUDED.ocr_capability,
    language_capability = EXCLUDED.language_capability,
    health_state = EXCLUDED.health_state,
    heartbeat_at = EXCLUDED.heartbeat_at;

  -- Instance identities change across deploys. Retain only a bounded operational window.
  DELETE FROM public.assistive_worker_heartbeats
   WHERE heartbeat_at < v_now - pg_catalog.make_interval(days => 7);

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'HEARTBEAT_RECORDED',
    'healthState', p_health_state,
    'heartbeatAt', v_now
  );
EXCEPTION WHEN check_violation OR data_exception THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_assistive_worker_heartbeat(text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_assistive_worker_heartbeat(text, text, text, text, text, text, text)
  TO service_role;

CREATE FUNCTION public.get_assistive_worker_availability(
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
  IF p_environment IS DISTINCT FROM 'staging'
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

COMMIT;
