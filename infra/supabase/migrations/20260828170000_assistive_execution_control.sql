-- Migration 0047: pre-start cost fencing and on-demand executor control.
--
-- This is a bounded operational side domain. Nothing below reads project content or writes
-- projects, media, review, approval, publication, public-feed, or validation-authority state.
-- It records only execution-control evidence: whether a heavy assistive worker may be started,
-- which start was authorised, and whether that start irrevocably consumed the PP1 cost ceiling.
--
-- Cost authority is a ROLLING 31-DAY WINDOW, not a calendar month. The provider documents its
-- free grant as "per calendar month" but does not document the reset timezone or instant, so a
-- calendar reset cannot be the hard fence. Any calendar month is at most 31 days, therefore
-- bounding every rolling 31-day interval to 40 consumed starts also bounds every calendar month
-- to at most 40 starts regardless of the provider's reset boundary. A UTC calendar-month count is
-- reported alongside it for operator readability only and carries no authority.
--
-- The irrevocability invariant is structural: only a reservation proven never to have transmitted
-- a start request may stop counting, and the table CHECK below is what makes any other refund
-- impossible.

BEGIN;

CREATE SCHEMA assistive_execution_control;

REVOKE ALL ON SCHEMA assistive_execution_control FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 1. Dedicated least-privilege dispatcher role.
--
-- Created without LOGIN. An operator enables login and sets a password out of band, so no
-- credential ever enters this repository. The role receives USAGE on this schema and EXECUTE on
-- exactly four execution-control functions: no table privileges, no public-schema usage, no
-- project data, no workflow or publication routine, and no service-role credential.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capstone_assistive_dispatcher'
  ) THEN
    CREATE ROLE capstone_assistive_dispatcher
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 4;
  END IF;
END
$$;

-- Re-asserted narrowly. LOGIN is deliberately untouched so replaying this migration cannot revoke
-- an operator's provisioned password. Only attributes a non-superuser owner may change are listed:
-- SUPERUSER, REPLICATION, and BYPASSRLS can never be granted by this migration's executing role,
-- so their absence is already guaranteed by the CREATE above and is asserted by the runtime
-- verifier rather than re-issued here.
ALTER ROLE capstone_assistive_dispatcher
  NOINHERIT NOCREATEDB NOCREATEROLE CONNECTION LIMIT 4;

GRANT USAGE ON SCHEMA assistive_execution_control TO capstone_assistive_dispatcher;

-- ---------------------------------------------------------------------------
-- 2. Serialisation and ceiling guard.
--
-- One environment-scoped row. It is not a counter: it exists to serialise reservation decisions
-- and to carry the ceiling as equality constraints. Raising the ceiling therefore requires a new
-- reviewed forward migration; no environment variable, configuration value, Admin action, or
-- browser path can change it.
-- ---------------------------------------------------------------------------

CREATE TABLE assistive_execution_control.launch_budget_guard (
  environment text PRIMARY KEY
    CONSTRAINT check_execution_control_guard_environment CHECK (environment = 'staging'),
  launch_limit integer NOT NULL
    CONSTRAINT check_execution_control_launch_limit CHECK (launch_limit = 40),
  window_days integer NOT NULL
    CONSTRAINT check_execution_control_window_days CHECK (window_days = 31),
  max_active_executions integer NOT NULL
    CONSTRAINT check_execution_control_max_active CHECK (max_active_executions = 1),
  next_generation bigint NOT NULL DEFAULT 1
    CONSTRAINT check_execution_control_next_generation CHECK (next_generation > 0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

INSERT INTO assistive_execution_control.launch_budget_guard
  (environment, launch_limit, window_days, max_active_executions)
VALUES ('staging', 40, 31, 1);

-- ---------------------------------------------------------------------------
-- 3. Launch reservations.
-- ---------------------------------------------------------------------------

CREATE TABLE assistive_execution_control.launch_reservations (
  reservation_token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL
    CONSTRAINT check_execution_control_reservation_environment CHECK (environment = 'staging'),
  execution_mode text NOT NULL
    CONSTRAINT check_execution_control_reservation_mode CHECK (execution_mode = 'ON_DEMAND'),
  generation bigint NOT NULL
    CONSTRAINT check_execution_control_reservation_generation CHECK (generation > 0),
  dispatcher_instance_id text NOT NULL
    CONSTRAINT check_execution_control_dispatcher_id
    CHECK (dispatcher_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  deployment_version text NOT NULL
    CONSTRAINT check_execution_control_reservation_deployment
    CHECK (deployment_version ~ '^[a-f0-9]{40}$'),
  image_digest text NOT NULL
    CONSTRAINT check_execution_control_reservation_digest
    CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL
    CONSTRAINT check_execution_control_reservation_state
    CHECK (state IN (
      'RESERVED', 'PRESTART_FAILED', 'START_REQUESTED', 'START_ACCEPTED',
      'START_RESPONSE_ERROR', 'START_AMBIGUOUS', 'EXECUTION_CLAIMED',
      'COMPLETED', 'FAILED', 'EXPIRED'
    )),
  -- The irrevocability invariant. A reservation may stop counting against the ceiling only when
  -- it is proven that no start request was ever transmitted.
  counts_against_budget boolean NOT NULL DEFAULT true
    CONSTRAINT check_execution_control_refund_only_before_transmission
    CHECK (counts_against_budget OR state = 'PRESTART_FAILED'),
  reserved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  start_requested_at timestamptz,
  start_recorded_at timestamptz,
  execution_reference text
    CONSTRAINT check_execution_control_execution_reference
    CHECK (execution_reference IS NULL OR execution_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  claimed_at timestamptz,
  worker_instance_id text
    CONSTRAINT check_execution_control_worker_id
    CHECK (worker_instance_id IS NULL OR worker_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  settled_at timestamptz,
  outcome_code text
    CONSTRAINT check_execution_control_outcome_code
    CHECK (outcome_code IS NULL OR outcome_code IN (
      'PRESTART_FAILED', 'START_ACCEPTED', 'START_RESPONSE_ERROR', 'START_AMBIGUOUS',
      'COMPLETED', 'FAILED', 'EXPIRED'
    )),
  processed_job_count integer NOT NULL DEFAULT 0
    CONSTRAINT check_execution_control_processed_count
    CHECK (processed_job_count BETWEEN 0 AND 1000),
  CONSTRAINT check_execution_control_reservation_window CHECK (expires_at > reserved_at)
);

-- Serves the rolling-window count.
CREATE INDEX launch_reservations_consumed_window_idx
  ON assistive_execution_control.launch_reservations (reserved_at DESC)
  WHERE counts_against_budget;

-- Serves the single-active-execution fence.
CREATE INDEX launch_reservations_active_fence_idx
  ON assistive_execution_control.launch_reservations (environment, expires_at)
  WHERE state IN (
    'RESERVED', 'START_REQUESTED', 'START_ACCEPTED',
    'START_RESPONSE_ERROR', 'START_AMBIGUOUS', 'EXECUTION_CLAIMED'
  );

-- ---------------------------------------------------------------------------
-- 4. Executor registration.
--
-- Published by an operator command at deployment time so Admin can truthfully report on-demand
-- availability before the first execution has ever run, and refreshed by each execution.
-- ---------------------------------------------------------------------------

CREATE TABLE assistive_execution_control.executor_registrations (
  environment text NOT NULL
    CONSTRAINT check_execution_control_registration_environment CHECK (environment = 'staging'),
  execution_mode text NOT NULL
    CONSTRAINT check_execution_control_registration_mode CHECK (execution_mode = 'ON_DEMAND'),
  pipeline_version text NOT NULL
    CONSTRAINT check_execution_control_registration_pipeline
    CHECK (pipeline_version = 'assistive-deterministic-checks/v3'),
  deployment_version text NOT NULL
    CONSTRAINT check_execution_control_registration_deployment
    CHECK (deployment_version ~ '^[a-f0-9]{40}$'),
  image_digest text NOT NULL
    CONSTRAINT check_execution_control_registration_digest
    CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  ocr_capability text NOT NULL
    CONSTRAINT check_execution_control_registration_ocr
    CHECK (ocr_capability = 'paddle-title/pp-ocrv6-small@3.7.0'),
  language_capability text NOT NULL
    CONSTRAINT check_execution_control_registration_language
    CHECK (language_capability = 'languagetool/en-au@6.6'),
  configuration_version text NOT NULL
    CONSTRAINT check_execution_control_registration_configuration
    CHECK (configuration_version ~ '^[a-z0-9][a-z0-9./-]{0,63}$'),
  registered_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_execution_at timestamptz,
  last_outcome_code text
    CONSTRAINT check_execution_control_registration_outcome
    CHECK (last_outcome_code IS NULL OR last_outcome_code IN ('COMPLETED', 'FAILED')),
  PRIMARY KEY (environment, execution_mode),
  CONSTRAINT check_execution_control_registration_window CHECK (expires_at > registered_at)
);

-- ---------------------------------------------------------------------------
-- 5. Row-level security. No application role reaches these relations directly.
-- ---------------------------------------------------------------------------

ALTER TABLE assistive_execution_control.launch_budget_guard ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistive_execution_control.launch_budget_guard FORCE ROW LEVEL SECURITY;
ALTER TABLE assistive_execution_control.launch_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistive_execution_control.launch_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE assistive_execution_control.executor_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistive_execution_control.executor_registrations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE assistive_execution_control.launch_budget_guard
  FROM PUBLIC, anon, authenticated, service_role, capstone_assistive_dispatcher;
REVOKE ALL ON TABLE assistive_execution_control.launch_reservations
  FROM PUBLIC, anon, authenticated, service_role, capstone_assistive_dispatcher;
REVOKE ALL ON TABLE assistive_execution_control.executor_registrations
  FROM PUBLIC, anon, authenticated, service_role, capstone_assistive_dispatcher;

-- ---------------------------------------------------------------------------
-- 6. Dispatcher surface (direct PostgreSQL, dispatcher role only).
-- ---------------------------------------------------------------------------

-- Cheap read-only probe. An optimisation that lets the dispatcher exit without any cloud
-- control-plane traffic on the overwhelmingly common empty-queue path. It creates nothing,
-- mutates nothing, returns no project content, and is never authority.
CREATE FUNCTION assistive_execution_control.inspect_assistive_launch_eligibility()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_guard assistive_execution_control.launch_budget_guard%ROWTYPE;
  v_consumed integer;
  v_active integer;
  v_result_code text;
BEGIN
  SELECT * INTO v_guard
    FROM assistive_execution_control.launch_budget_guard
   WHERE environment = 'staging';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTOR_UNREGISTERED');
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_consumed
    FROM assistive_execution_control.launch_reservations
   WHERE counts_against_budget
     AND reserved_at > v_now - pg_catalog.make_interval(days => v_guard.window_days);

  SELECT pg_catalog.count(*)::integer INTO v_active
    FROM assistive_execution_control.launch_reservations
   WHERE environment = 'staging'
     AND expires_at > v_now
     AND state IN (
       'RESERVED', 'START_REQUESTED', 'START_ACCEPTED',
       'START_RESPONSE_ERROR', 'START_AMBIGUOUS', 'EXECUTION_CLAIMED'
     );

  IF v_consumed >= v_guard.launch_limit THEN
    v_result_code := 'BUDGET_EXHAUSTED';
  ELSIF v_active >= v_guard.max_active_executions THEN
    v_result_code := 'ACTIVE_LAUNCH';
  ELSIF NOT EXISTS (
    SELECT 1 FROM assistive_execution_control.executor_registrations AS r
     WHERE r.environment = 'staging' AND r.execution_mode = 'ON_DEMAND' AND r.expires_at > v_now
  ) THEN
    v_result_code := 'EXECUTOR_UNREGISTERED';
  ELSIF EXISTS (
    SELECT 1 FROM public.assistive_validation_jobs AS j
     WHERE (j.status = 'QUEUED' AND j.available_at <= v_now)
        OR (j.status IN ('EXTRACTING', 'CHECKING') AND j.lease_until <= v_now)
  ) THEN
    v_result_code := 'WORK_AVAILABLE';
  ELSE
    v_result_code := 'NO_WORK';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', v_result_code,
    'launchLimit', v_guard.launch_limit,
    'windowDays', v_guard.window_days,
    'consumedInWindow', v_consumed,
    'activeExecutions', v_active
  );
END;
$$;

REVOKE ALL ON FUNCTION assistive_execution_control.inspect_assistive_launch_eligibility()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION assistive_execution_control.inspect_assistive_launch_eligibility()
  TO capstone_assistive_dispatcher;

-- Authoritative pre-start reservation. Consumes one unit of the rolling-window ceiling before
-- any cloud start request may be transmitted. Trusts neither the probe nor any caller preflight:
-- every condition is rechecked here under the guard row lock.
CREATE FUNCTION assistive_execution_control.reserve_assistive_launch(
  p_dispatcher_instance_id text,
  p_deployment_version text,
  p_image_digest text,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_guard assistive_execution_control.launch_budget_guard%ROWTYPE;
  v_registration assistive_execution_control.executor_registrations%ROWTYPE;
  v_deployment text := pg_catalog.lower(COALESCE(p_deployment_version, ''));
  v_digest text := pg_catalog.lower(COALESCE(p_image_digest, ''));
  v_consumed integer;
  v_active integer;
  v_generation bigint;
  v_token uuid;
  v_expires timestamptz;
BEGIN
  IF COALESCE(p_dispatcher_instance_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR v_deployment !~ '^[a-f0-9]{40}$'
     OR v_digest !~ '^sha256:[a-f0-9]{64}$'
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 300 AND 1800
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_guard
    FROM assistive_execution_control.launch_budget_guard
   WHERE environment = 'staging'
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- Expire stale reservations so the single-active fence clears. This never refunds: the
  -- counts_against_budget column is deliberately untouched.
  UPDATE assistive_execution_control.launch_reservations
     SET state = 'EXPIRED',
         outcome_code = COALESCE(outcome_code, 'EXPIRED'),
         settled_at = COALESCE(settled_at, v_now)
   WHERE environment = 'staging'
     AND expires_at <= v_now
     AND state IN (
       'RESERVED', 'START_REQUESTED', 'START_ACCEPTED',
       'START_RESPONSE_ERROR', 'START_AMBIGUOUS', 'EXECUTION_CLAIMED'
     );

  -- Bounded retention, safely beyond the rolling window.
  DELETE FROM assistive_execution_control.launch_reservations
   WHERE reserved_at < v_now - pg_catalog.make_interval(days => 90);

  SELECT pg_catalog.count(*)::integer INTO v_consumed
    FROM assistive_execution_control.launch_reservations
   WHERE counts_against_budget
     AND reserved_at > v_now - pg_catalog.make_interval(days => v_guard.window_days);

  IF v_consumed >= v_guard.launch_limit THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'BUDGET_EXHAUSTED',
      'launchLimit', v_guard.launch_limit,
      'windowDays', v_guard.window_days,
      'consumedInWindow', v_consumed
    );
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_active
    FROM assistive_execution_control.launch_reservations
   WHERE environment = 'staging'
     AND expires_at > v_now
     AND state IN (
       'RESERVED', 'START_REQUESTED', 'START_ACCEPTED',
       'START_RESPONSE_ERROR', 'START_AMBIGUOUS', 'EXECUTION_CLAIMED'
     );

  IF v_active >= v_guard.max_active_executions THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ACTIVE_LAUNCH',
      'activeExecutions', v_active
    );
  END IF;

  SELECT * INTO v_registration
    FROM assistive_execution_control.executor_registrations
   WHERE environment = 'staging'
     AND execution_mode = 'ON_DEMAND'
     AND expires_at > v_now;
  IF NOT FOUND
     OR v_registration.deployment_version IS DISTINCT FROM v_deployment
     OR v_registration.image_digest IS DISTINCT FROM v_digest
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTOR_UNREGISTERED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.assistive_validation_jobs AS j
     WHERE (j.status = 'QUEUED' AND j.available_at <= v_now)
        OR (j.status IN ('EXTRACTING', 'CHECKING') AND j.lease_until <= v_now)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NO_WORK');
  END IF;

  UPDATE assistive_execution_control.launch_budget_guard
     SET next_generation = next_generation + 1, updated_at = v_now
   WHERE environment = 'staging'
  RETURNING next_generation - 1 INTO v_generation;

  v_expires := v_now + pg_catalog.make_interval(secs => p_lease_seconds);

  INSERT INTO assistive_execution_control.launch_reservations (
    environment, execution_mode, generation, dispatcher_instance_id,
    deployment_version, image_digest, state, counts_against_budget, reserved_at, expires_at
  ) VALUES (
    'staging', 'ON_DEMAND', v_generation, p_dispatcher_instance_id,
    v_deployment, v_digest, 'RESERVED', true, v_now, v_expires
  )
  RETURNING reservation_token INTO v_token;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RESERVED',
    'reservationToken', v_token,
    'generation', v_generation,
    'launchLimit', v_guard.launch_limit,
    'windowDays', v_guard.window_days,
    'consumedInWindow', v_consumed + 1,
    'expiresAt', v_expires
  );
EXCEPTION WHEN check_violation OR data_exception THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

REVOKE ALL ON FUNCTION assistive_execution_control.reserve_assistive_launch(text, text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION assistive_execution_control.reserve_assistive_launch(text, text, text, integer)
  TO capstone_assistive_dispatcher;

-- Durable point of no refund. Recorded before the start request is transmitted, so a dispatcher
-- that dies at any later point still leaves the unit consumed.
CREATE FUNCTION assistive_execution_control.mark_assistive_launch_requested(
  p_reservation_token uuid,
  p_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_updated integer;
BEGIN
  IF p_reservation_token IS NULL OR p_generation IS NULL OR p_generation <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  UPDATE assistive_execution_control.launch_reservations
     SET state = 'START_REQUESTED', start_requested_at = v_now
   WHERE reservation_token = p_reservation_token
     AND generation = p_generation
     AND state = 'RESERVED'
     AND expires_at > v_now;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'FENCED');
  END IF;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'START_REQUESTED');
END;
$$;

REVOKE ALL ON FUNCTION assistive_execution_control.mark_assistive_launch_requested(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION assistive_execution_control.mark_assistive_launch_requested(uuid, bigint)
  TO capstone_assistive_dispatcher;

-- Records what happened to the start request.
--
-- PRESTART_FAILED is accepted only from RESERVED, which is the sole state proving no start request
-- was ever transmitted; it is the only outcome that releases the unit. Every outcome reachable
-- after transmission leaves counts_against_budget true, and the table CHECK makes any other
-- refund impossible even if this function were changed incorrectly.
CREATE FUNCTION assistive_execution_control.record_assistive_launch_outcome(
  p_reservation_token uuid,
  p_generation bigint,
  p_outcome text,
  p_execution_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_updated integer;
BEGIN
  IF p_reservation_token IS NULL
     OR p_generation IS NULL
     OR p_generation <= 0
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('PRESTART_FAILED', 'START_ACCEPTED', 'START_RESPONSE_ERROR', 'START_AMBIGUOUS')
     OR (p_execution_reference IS NOT NULL
         AND p_execution_reference !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$')
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF p_outcome = 'PRESTART_FAILED' THEN
    UPDATE assistive_execution_control.launch_reservations
       SET state = 'PRESTART_FAILED',
           counts_against_budget = false,
           outcome_code = 'PRESTART_FAILED',
           settled_at = v_now
     WHERE reservation_token = p_reservation_token
       AND generation = p_generation
       AND state = 'RESERVED';
  ELSE
    UPDATE assistive_execution_control.launch_reservations
       SET state = p_outcome,
           outcome_code = p_outcome,
           start_recorded_at = v_now,
           execution_reference = p_execution_reference
     WHERE reservation_token = p_reservation_token
       AND generation = p_generation
       AND state = 'START_REQUESTED';
  END IF;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'FENCED');
  END IF;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'OUTCOME_RECORDED', 'state', p_outcome);
END;
$$;

REVOKE ALL ON FUNCTION assistive_execution_control.record_assistive_launch_outcome(uuid, bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION assistive_execution_control.record_assistive_launch_outcome(uuid, bigint, text, text)
  TO capstone_assistive_dispatcher;

-- ---------------------------------------------------------------------------
-- 7. Worker and Admin surface (PostgREST, service_role only).
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.register_assistive_executor(
  p_deployment_version text,
  p_image_digest text,
  p_configuration_version text,
  p_registration_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_deployment text := pg_catalog.lower(COALESCE(p_deployment_version, ''));
  v_digest text := pg_catalog.lower(COALESCE(p_image_digest, ''));
  v_expires timestamptz;
BEGIN
  IF v_deployment !~ '^[a-f0-9]{40}$'
     OR v_digest !~ '^sha256:[a-f0-9]{64}$'
     OR COALESCE(p_configuration_version, '') !~ '^[a-z0-9][a-z0-9./-]{0,63}$'
     OR p_registration_days IS NULL
     OR p_registration_days NOT BETWEEN 1 AND 180
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  v_expires := v_now + pg_catalog.make_interval(days => p_registration_days);

  INSERT INTO assistive_execution_control.executor_registrations (
    environment, execution_mode, pipeline_version, deployment_version, image_digest,
    ocr_capability, language_capability, configuration_version, registered_at, expires_at
  ) VALUES (
    'staging', 'ON_DEMAND', 'assistive-deterministic-checks/v3', v_deployment, v_digest,
    'paddle-title/pp-ocrv6-small@3.7.0', 'languagetool/en-au@6.6',
    p_configuration_version, v_now, v_expires
  )
  ON CONFLICT (environment, execution_mode) DO UPDATE SET
    pipeline_version = EXCLUDED.pipeline_version,
    deployment_version = EXCLUDED.deployment_version,
    image_digest = EXCLUDED.image_digest,
    ocr_capability = EXCLUDED.ocr_capability,
    language_capability = EXCLUDED.language_capability,
    configuration_version = EXCLUDED.configuration_version,
    registered_at = EXCLUDED.registered_at,
    expires_at = EXCLUDED.expires_at;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'REGISTERED',
    'deploymentVersion', v_deployment,
    'imageDigest', v_digest,
    'expiresAt', v_expires
  );
EXCEPTION WHEN check_violation OR data_exception THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

REVOKE ALL ON FUNCTION public.register_assistive_executor(text, text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_assistive_executor(text, text, text, integer)
  TO service_role;

-- The worker's first application action. Nothing may load a provider before this returns CLAIMED.
CREATE FUNCTION public.claim_assistive_execution_reservation(
  p_reservation_token uuid,
  p_generation bigint,
  p_worker_instance_id text,
  p_deployment_version text,
  p_image_digest text,
  p_execution_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_deployment text := pg_catalog.lower(COALESCE(p_deployment_version, ''));
  v_digest text := pg_catalog.lower(COALESCE(p_image_digest, ''));
  v_reservation assistive_execution_control.launch_reservations%ROWTYPE;
BEGIN
  IF p_reservation_token IS NULL
     OR p_generation IS NULL
     OR p_generation <= 0
     OR COALESCE(p_worker_instance_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR v_deployment !~ '^[a-f0-9]{40}$'
     OR v_digest !~ '^sha256:[a-f0-9]{64}$'
     OR p_execution_mode IS DISTINCT FROM 'ON_DEMAND'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_reservation
    FROM assistive_execution_control.launch_reservations
   WHERE reservation_token = p_reservation_token
     FOR UPDATE;
  IF NOT FOUND
     OR v_reservation.generation IS DISTINCT FROM p_generation
     OR v_reservation.execution_mode IS DISTINCT FROM p_execution_mode
     OR v_reservation.expires_at <= v_now
     OR v_reservation.claimed_at IS NOT NULL
     OR v_reservation.state NOT IN (
       'START_REQUESTED', 'START_ACCEPTED', 'START_RESPONSE_ERROR', 'START_AMBIGUOUS'
     )
     OR v_reservation.deployment_version IS DISTINCT FROM v_deployment
     OR v_reservation.image_digest IS DISTINCT FROM v_digest
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_REFUSED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM assistive_execution_control.executor_registrations AS r
     WHERE r.environment = 'staging'
       AND r.execution_mode = 'ON_DEMAND'
       AND r.expires_at > v_now
       AND r.deployment_version = v_deployment
       AND r.image_digest = v_digest
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_REFUSED');
  END IF;

  UPDATE assistive_execution_control.launch_reservations
     SET state = 'EXECUTION_CLAIMED', claimed_at = v_now, worker_instance_id = p_worker_instance_id
   WHERE reservation_token = p_reservation_token;

  UPDATE assistive_execution_control.executor_registrations
     SET last_execution_at = v_now
   WHERE environment = 'staging' AND execution_mode = 'ON_DEMAND';

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'CLAIMED',
    'expiresAt', v_reservation.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_assistive_execution_reservation(uuid, bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_assistive_execution_reservation(uuid, bigint, text, text, text, text)
  TO service_role;

CREATE FUNCTION public.settle_assistive_execution_reservation(
  p_reservation_token uuid,
  p_generation bigint,
  p_outcome text,
  p_processed_job_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_updated integer;
BEGIN
  IF p_reservation_token IS NULL
     OR p_generation IS NULL
     OR p_generation <= 0
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('COMPLETED', 'FAILED')
     OR p_processed_job_count IS NULL
     OR p_processed_job_count NOT BETWEEN 0 AND 1000
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  UPDATE assistive_execution_control.launch_reservations
     SET state = p_outcome,
         outcome_code = p_outcome,
         processed_job_count = p_processed_job_count,
         settled_at = v_now
   WHERE reservation_token = p_reservation_token
     AND generation = p_generation
     AND state = 'EXECUTION_CLAIMED';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'FENCED');
  END IF;

  UPDATE assistive_execution_control.executor_registrations
     SET last_outcome_code = p_outcome
   WHERE environment = 'staging' AND execution_mode = 'ON_DEMAND';

  RETURN pg_catalog.jsonb_build_object('resultCode', 'SETTLED', 'state', p_outcome);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_assistive_execution_reservation(uuid, bigint, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_assistive_execution_reservation(uuid, bigint, text, integer)
  TO service_role;

-- Admin availability. Reports the authoritative rolling-window state, plus a UTC calendar-month
-- count that exists purely for operator readability and carries no authority.
CREATE FUNCTION public.get_assistive_executor_availability(
  p_pipeline_version text,
  p_deployment_version text,
  p_image_digest text,
  p_ocr_capability text,
  p_language_capability text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_guard assistive_execution_control.launch_budget_guard%ROWTYPE;
  v_registration assistive_execution_control.executor_registrations%ROWTYPE;
  v_deployment text := pg_catalog.lower(COALESCE(p_deployment_version, ''));
  v_digest text := pg_catalog.lower(COALESCE(p_image_digest, ''));
  v_consumed integer;
  v_month_starts integer;
  v_active integer;
  v_result_code text;
BEGIN
  IF p_pipeline_version IS DISTINCT FROM 'assistive-deterministic-checks/v3'
     OR v_deployment !~ '^[a-f0-9]{40}$'
     OR v_digest !~ '^sha256:[a-f0-9]{64}$'
     OR p_ocr_capability IS DISTINCT FROM 'paddle-title/pp-ocrv6-small@3.7.0'
     OR p_language_capability IS DISTINCT FROM 'languagetool/en-au@6.6'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_guard
    FROM assistive_execution_control.launch_budget_guard
   WHERE environment = 'staging';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_consumed
    FROM assistive_execution_control.launch_reservations
   WHERE counts_against_budget
     AND reserved_at > v_now - pg_catalog.make_interval(days => v_guard.window_days);

  -- Reporting only.
  SELECT pg_catalog.count(*)::integer INTO v_month_starts
    FROM assistive_execution_control.launch_reservations
   WHERE counts_against_budget
     AND reserved_at >= pg_catalog.date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  SELECT pg_catalog.count(*)::integer INTO v_active
    FROM assistive_execution_control.launch_reservations
   WHERE environment = 'staging'
     AND expires_at > v_now
     AND state IN (
       'RESERVED', 'START_REQUESTED', 'START_ACCEPTED',
       'START_RESPONSE_ERROR', 'START_AMBIGUOUS', 'EXECUTION_CLAIMED'
     );

  SELECT * INTO v_registration
    FROM assistive_execution_control.executor_registrations
   WHERE environment = 'staging'
     AND execution_mode = 'ON_DEMAND'
     AND expires_at > v_now
     AND pipeline_version = p_pipeline_version
     AND deployment_version = v_deployment
     AND image_digest = v_digest
     AND ocr_capability = p_ocr_capability
     AND language_capability = p_language_capability;

  IF NOT FOUND THEN
    v_result_code := 'UNAVAILABLE';
  ELSIF v_consumed >= v_guard.launch_limit THEN
    v_result_code := 'BUDGET_EXHAUSTED';
  ELSE
    v_result_code := 'AVAILABLE';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', v_result_code,
    'executionMode', 'ON_DEMAND',
    'launchLimit', v_guard.launch_limit,
    'windowDays', v_guard.window_days,
    'consumedInWindow', v_consumed,
    -- GREATEST is a SQL construct rather than a catalog function, so it needs no qualification.
    'remainingInWindow', GREATEST(v_guard.launch_limit - v_consumed, 0),
    'activeExecutions', v_active,
    'utcCalendarMonthStarts', v_month_starts,
    'lastExecutionAt', v_registration.last_execution_at,
    'registrationExpiresAt', v_registration.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_assistive_executor_availability(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_assistive_executor_availability(text, text, text, text, text)
  TO service_role;

COMMIT;
