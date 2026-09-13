-- PP1 A-06: explicit, exact-head rollback capability control for verified staging.
--
-- This migration creates no capability event and changes no existing application row. A current
-- administrator must invoke the service-role-only RPC with exact current-head evidence and the
-- exact typed confirmation before rollback_enabled can change.

BEGIN;

CREATE TABLE public.public_feed_rollback_capability_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE,
  actor_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  previous_enabled boolean NOT NULL,
  enabled boolean NOT NULL,
  head_version_id uuid NOT NULL REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT,
  head_version_number bigint NOT NULL CHECK (head_version_number > 0),
  head_generation bigint NOT NULL CHECK (head_generation > 0),
  head_feed_hash text NOT NULL CHECK (head_feed_hash ~ '^[0-9a-f]{64}$'),
  head_record_count integer NOT NULL CHECK (head_record_count >= 0),
  confirmation_digest text NOT NULL CHECK (confirmation_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT public_feed_rollback_capability_transition_required
    CHECK (previous_enabled IS DISTINCT FROM enabled)
);

CREATE INDEX public_feed_rollback_capability_events_actor_idx
  ON public.public_feed_rollback_capability_events(actor_id, created_at DESC);
CREATE INDEX public_feed_rollback_capability_events_head_version_idx
  ON public.public_feed_rollback_capability_events(
    head_version_id, head_version_number, head_generation, sequence DESC
  );

CREATE TABLE public.public_feed_rollback_preparation_capabilities (
  preparation_handle uuid PRIMARY KEY
    REFERENCES public.feed_rollback_preparations(handle) ON DELETE RESTRICT,
  capability_event_id uuid NOT NULL
    REFERENCES public.public_feed_rollback_capability_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX public_feed_rollback_preparation_capabilities_event_idx
  ON public.public_feed_rollback_preparation_capabilities(capability_event_id);

CREATE TRIGGER reject_public_feed_rollback_capability_event_mutation
  BEFORE UPDATE OR DELETE ON public.public_feed_rollback_capability_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_public_feed_immutable_mutation();
CREATE TRIGGER reject_public_feed_rollback_preparation_capability_mutation
  BEFORE UPDATE OR DELETE ON public.public_feed_rollback_preparation_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.reject_public_feed_immutable_mutation();

ALTER TABLE public.public_feed_rollback_capability_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_rollback_capability_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_rollback_preparation_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_rollback_preparation_capabilities FORCE ROW LEVEL SECURITY;

CREATE POLICY deny_authenticated_public_feed_rollback_capability_events
  ON public.public_feed_rollback_capability_events
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);
CREATE POLICY deny_authenticated_public_feed_rollback_preparation_capabilities
  ON public.public_feed_rollback_preparation_capabilities
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.public_feed_rollback_capability_events
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.public_feed_rollback_preparation_capabilities
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.public_feed_rollback_capability_events,
  public.public_feed_rollback_preparation_capabilities TO service_role;

-- Migration 0053 made lifecycle state and pending activation authoritative. Every writer RPC that
-- already calls this helper now shares the lifecycle transition lock before taking the canonical
-- writer lock. This closes retained-role and concurrent-deactivation races without changing the
-- forward-only behavior of owner-token recovery transitions that intentionally do not call it.
CREATE OR REPLACE FUNCTION public.public_feed_actor_is_admin(p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active_admin_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capstone.staff_lifecycle_admin_invariant', 0)
  );

  -- The row lock provides READ COMMITTED update-chain re-evaluation after a concurrent lifecycle
  -- transaction releases the advisory lock; a call that began with an older statement snapshot
  -- cannot continue on a now-deactivated row.
  SELECT au.id INTO v_active_admin_id
  FROM public.admin_users au
  WHERE au.id = p_actor_id
    AND au.auth_user_id IS NOT NULL
    AND au.lifecycle_status = 'active'
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = au.id AND ur.role = 'admin'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.staff_provisioning_requests request
      WHERE request.admin_user_id = au.id
        AND request.status = 'pending_activation'
    )
  FOR SHARE;

  RETURN v_active_admin_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.public_feed_actor_is_admin(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The raw head bit preserves the historical disposable-Local contract. Verified staging also
-- requires the latest transition for this immutable head to be an enable event with exact
-- version/generation/hash/count evidence. A later head therefore expires staging authority even
-- though Local behavior remains unchanged.
CREATE OR REPLACE FUNCTION public.current_public_feed_rollback_capability_event()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT event.id
  FROM public.public_feed_head head
  JOIN public.public_feed_versions version ON version.id = head.current_version_id
  JOIN LATERAL (
    SELECT candidate.id, candidate.enabled
    FROM public.public_feed_rollback_capability_events candidate
    WHERE candidate.head_version_id = head.current_version_id
      AND candidate.head_version_number = version.version_number
      AND candidate.head_generation = head.generation
      AND candidate.head_feed_hash = version.feed_hash
      AND candidate.head_record_count = version.record_count
    ORDER BY candidate.sequence DESC
    LIMIT 1
  ) event ON true
  WHERE head.singleton = true
    AND head.rollback_enabled = true
    AND event.enabled = true
$$;

REVOKE ALL ON FUNCTION public.current_public_feed_rollback_capability_event()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.transition_public_feed_rollback_capability(
  p_admin_id uuid,
  p_enabled boolean,
  p_require_exact_head_event boolean,
  p_expected_version_number bigint,
  p_expected_generation bigint,
  p_expected_feed_hash text,
  p_expected_record_count integer,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_head public.public_feed_head%ROWTYPE;
  v_version public.public_feed_versions%ROWTYPE;
  v_required_confirmation text;
  v_event_id uuid;
  v_event_created_at timestamptz;
  v_previous_enabled boolean;
BEGIN
  IF p_enabled IS NULL
     OR p_require_exact_head_event IS NULL
     OR p_expected_version_number IS NULL OR p_expected_version_number <= 0
     OR p_expected_generation IS NULL OR p_expected_generation <= 0
     OR p_expected_feed_hash IS NULL OR p_expected_feed_hash !~ '^[0-9a-f]{64}$'
     OR p_expected_record_count IS NULL OR p_expected_record_count < 0
     OR p_confirmation IS NULL OR pg_catalog.length(p_confirmation) > 256
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT');
  END IF;

  -- The active-admin helper takes the lifecycle lock first. Every staff lifecycle transition uses
  -- that same lock, so the actor cannot be deactivated between authorization and commit.
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- Always take locks in lifecycle -> canonical-writer order. This serializes the transition with
  -- reserve, prepare, finalize, recovery, and another capability transition without a row-lock
  -- inversion against manage_staff_lifecycle.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );

  IF EXISTS (
    SELECT 1
    FROM public.public_feed_operations o
    WHERE o.state = 'RECOVERY_REQUIRED'
  ) OR EXISTS (
    SELECT 1 FROM public.publication_attempts a WHERE a.state = 'compensation_failed'
  ) OR EXISTS (
    SELECT 1 FROM public.public_removal_attempts a WHERE a.state = 'compensation_failed'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'RECOVERY_REQUIRED');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.public_feed_operations o
    WHERE o.state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED')
  ) OR EXISTS (
    SELECT 1
    FROM public.publication_attempts a
    WHERE a.state IN ('reserved', 'prepared', 'storage_written')
  ) OR EXISTS (
    SELECT 1
    FROM public.public_removal_attempts a
    WHERE a.state IN ('reserved', 'prepared', 'storage_written')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLICATION_IN_PROGRESS');
  END IF;

  SELECT * INTO v_head
  FROM public.public_feed_head
  WHERE singleton = true
  FOR UPDATE;

  IF v_head.singleton IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'HISTORY_NOT_ACTIVE');
  END IF;

  SELECT * INTO v_version
  FROM public.public_feed_versions
  WHERE id = v_head.current_version_id;

  IF v_version.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'HEAD_CORRUPT');
  END IF;

  IF v_version.version_number IS DISTINCT FROM p_expected_version_number
     OR v_head.generation IS DISTINCT FROM p_expected_generation
     OR v_version.feed_hash IS DISTINCT FROM p_expected_feed_hash
     OR v_version.record_count IS DISTINCT FROM p_expected_record_count
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_HEAD');
  END IF;

  v_required_confirmation := CASE WHEN p_enabled THEN 'ENABLE' ELSE 'DISABLE' END
    || ' PUBLIC FEED ROLLBACK FOR VERSION ' || v_version.version_number::text
    || ' GENERATION ' || v_head.generation::text
    || ' HASH ' || v_version.feed_hash
    || ' COUNT ' || v_version.record_count::text;

  IF p_confirmation IS DISTINCT FROM v_required_confirmation THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'CONFIRMATION_MISMATCH',
      'requiredConfirmation', v_required_confirmation
    );
  END IF;

  v_previous_enabled := CASE
    WHEN p_require_exact_head_event
      THEN public.current_public_feed_rollback_capability_event() IS NOT NULL
    ELSE v_head.rollback_enabled
  END;

  IF v_previous_enabled IS NOT DISTINCT FROM p_enabled THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'NO_CHANGE',
      'rollbackEnabled', v_previous_enabled,
      'versionNumber', v_version.version_number,
      'generation', v_head.generation,
      'feedHash', v_version.feed_hash,
      'recordCount', v_version.record_count
    );
  END IF;

  UPDATE public.public_feed_head
  SET rollback_enabled = p_enabled
  WHERE singleton = true
    AND current_version_id = v_version.id
    AND generation = v_head.generation;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_HEAD');
  END IF;

  INSERT INTO public.public_feed_rollback_capability_events(
    actor_id,
    previous_enabled,
    enabled,
    head_version_id,
    head_version_number,
    head_generation,
    head_feed_hash,
    head_record_count,
    confirmation_digest
  ) VALUES (
    p_admin_id,
    v_previous_enabled,
    p_enabled,
    v_version.id,
    v_version.version_number,
    v_head.generation,
    v_version.feed_hash,
    v_version.record_count,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(p_confirmation, 'UTF8'), 'sha256'),
      'hex'
    )
  )
  RETURNING id, created_at INTO v_event_id, v_event_created_at;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'CAPABILITY_UPDATED',
    'eventId', v_event_id::text,
    'createdAt', v_event_created_at,
    'previousEnabled', v_previous_enabled,
    'rollbackEnabled', p_enabled,
    'versionNumber', v_version.version_number,
    'generation', v_head.generation,
    'feedHash', v_version.feed_hash,
    'recordCount', v_version.record_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transition_public_feed_rollback_capability(
  uuid, boolean, boolean, bigint, bigint, text, integer, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transition_public_feed_rollback_capability(
  uuid, boolean, boolean, bigint, bigint, text, integer, text
) TO service_role;

-- Staging preparation is atomic with exact current-head capability inspection. The returned
-- preparation is durably bound to that event, so a disable/re-enable cycle invalidates an older
-- preparation even when the immutable head itself has not moved.
CREATE OR REPLACE FUNCTION public.prepare_verified_staging_public_feed_rollback(
  p_admin_id uuid,
  p_target_version_number bigint,
  p_observed_storage_hash text,
  p_observed_storage_record_count integer,
  p_lifecycle_drift jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_capability_event_id uuid;
  v_result jsonb;
  v_preparation_handle uuid;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );
  v_capability_event_id := public.current_public_feed_rollback_capability_event();
  IF v_capability_event_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ROLLBACK_UNAVAILABLE');
  END IF;

  v_result := public.prepare_public_feed_rollback(
    p_admin_id,
    p_target_version_number,
    p_observed_storage_hash,
    p_observed_storage_record_count,
    p_lifecycle_drift
  );
  IF v_result->>'resultCode' <> 'PREPARED' THEN
    RETURN v_result;
  END IF;

  v_preparation_handle := (v_result->>'preparationHandle')::uuid;
  INSERT INTO public.public_feed_rollback_preparation_capabilities(
    preparation_handle, capability_event_id
  ) VALUES (v_preparation_handle, v_capability_event_id);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_verified_staging_public_feed_rollback(
  uuid, bigint, text, integer, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_verified_staging_public_feed_rollback(
  uuid, bigint, text, integer, jsonb
) TO service_role;

-- Staging execution accepts only a preparation whose bound event is still the exact current
-- enable event. The legacy Local reserve RPC remains untouched and retains its loopback semantics.
CREATE OR REPLACE FUNCTION public.reserve_verified_staging_public_feed_rollback(
  p_admin_id uuid,
  p_owner_token text,
  p_rollback_preparation_handle uuid,
  p_rollback_acknowledgement text,
  p_storage_bucket text,
  p_storage_path text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bound_capability_event_id uuid;
  v_current_capability_event_id uuid;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );
  SELECT binding.capability_event_id
  INTO v_bound_capability_event_id
  FROM public.feed_rollback_preparations preparation
  LEFT JOIN public.public_feed_rollback_preparation_capabilities binding
    ON binding.preparation_handle = preparation.handle
  WHERE preparation.handle = p_rollback_preparation_handle
  FOR UPDATE OF preparation;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_PREPARATION');
  END IF;

  v_current_capability_event_id := public.current_public_feed_rollback_capability_event();
  IF v_bound_capability_event_id IS NULL
     OR v_current_capability_event_id IS DISTINCT FROM v_bound_capability_event_id
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ROLLBACK_UNAVAILABLE');
  END IF;

  RETURN public.reserve_public_feed_operation(
    NULL,
    'rollback',
    NULL,
    p_admin_id,
    NULL,
    p_owner_token,
    NULL,
    NULL,
    NULL,
    NULL,
    p_rollback_preparation_handle,
    p_rollback_acknowledgement,
    p_storage_bucket,
    p_storage_path,
    false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_verified_staging_public_feed_rollback(
  uuid, text, uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_verified_staging_public_feed_rollback(
  uuid, text, uuid, text, text, text
) TO service_role;

-- Readiness can now distinguish the repository candidate that includes the rollback capability
-- authority. This remains a read-only stamp; it neither enables rollback nor claims hosted use.
CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT '20260910120000_public_feed_rollback_capability|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()
  TO service_role;

COMMIT;
