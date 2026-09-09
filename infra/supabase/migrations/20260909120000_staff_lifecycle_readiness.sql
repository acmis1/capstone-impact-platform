-- Migration 0053: controlled staff lifecycle, active-session RLS, and immutable release readiness.
--
-- PostgreSQL is the authoritative Admin/CMS authorization boundary. Lifecycle transitions commit
-- there before Supabase Auth is contacted, so an unavailable provider can never restore access.
-- Provider work is represented by a token-fenced, expiring reconciliation claim and may be
-- retried safely. Staff profiles, role history and lifecycle audit history are never deleted.

BEGIN;

ALTER TABLE public.admin_users
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'active'
    CONSTRAINT check_admin_user_lifecycle_status
    CHECK (lifecycle_status IN ('active', 'deactivated')),
  ADD COLUMN lifecycle_version bigint NOT NULL DEFAULT 1
    CONSTRAINT check_admin_user_lifecycle_version
    CHECK (lifecycle_version > 0),
  ADD COLUMN lifecycle_updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ADD COLUMN deactivated_at timestamptz;

ALTER TABLE public.admin_users
  ADD CONSTRAINT check_admin_user_deactivation_timestamp
  CHECK (
    (lifecycle_status = 'active' AND deactivated_at IS NULL)
    OR (lifecycle_status = 'deactivated' AND deactivated_at IS NOT NULL)
  );

-- Preserve the staff profile and its audit attribution if an Auth identity is ever removed by an
-- independently governed provider operation. This replaces the historical cascading FK only.
ALTER TABLE public.admin_users
  DROP CONSTRAINT fk_admin_users_auth_users;
ALTER TABLE public.admin_users
  ADD CONSTRAINT fk_admin_users_auth_users
  FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Lifecycle APIs address staff by normalized email and must fail migration rather than operate on
-- an ambiguous historical identity set.
CREATE UNIQUE INDEX admin_users_normalized_email_uidx
  ON public.admin_users (pg_catalog.lower(pg_catalog.btrim(email)));

CREATE TABLE public.staff_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_admin_user_id uuid NOT NULL
    REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  actor_admin_user_id uuid NOT NULL
    REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  target_email_snapshot text NOT NULL,
  target_full_name_snapshot text NOT NULL,
  actor_email_snapshot text NOT NULL,
  actor_full_name_snapshot text NOT NULL,
  action text NOT NULL
    CONSTRAINT check_staff_lifecycle_event_action
    CHECK (action IN ('role_set_replaced', 'deactivated', 'reactivated')),
  previous_status text NOT NULL,
  next_status text NOT NULL,
  previous_roles text[] NOT NULL,
  next_roles text[] NOT NULL,
  lifecycle_version bigint NOT NULL CHECK (lifecycle_version > 1),
  provider_action text NOT NULL,
  provider_status text NOT NULL,
  provider_failure_code text,
  provider_attempt_count integer NOT NULL DEFAULT 0 CHECK (provider_attempt_count >= 0),
  provider_claim_token_hash text,
  provider_claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  provider_updated_at timestamptz,
  CONSTRAINT unique_staff_lifecycle_target_version
    UNIQUE (target_admin_user_id, lifecycle_version),
  CONSTRAINT check_staff_lifecycle_event_statuses
    CHECK (
      previous_status IN ('active', 'deactivated')
      AND next_status IN ('active', 'deactivated')
    ),
  CONSTRAINT check_staff_lifecycle_event_previous_roles
    CHECK (
      pg_catalog.cardinality(previous_roles) BETWEEN 0 AND 3
      AND pg_catalog.array_position(previous_roles, NULL) IS NULL
      AND previous_roles <@ ARRAY['admin', 'reviewer', 'editor']::text[]
    ),
  CONSTRAINT check_staff_lifecycle_event_next_roles
    CHECK (
      pg_catalog.cardinality(next_roles) BETWEEN 0 AND 3
      AND pg_catalog.array_position(next_roles, NULL) IS NULL
      AND next_roles <@ ARRAY['admin', 'reviewer', 'editor']::text[]
    ),
  CONSTRAINT check_staff_lifecycle_provider_action
    CHECK (provider_action IN ('none', 'disable', 'enable')),
  CONSTRAINT check_staff_lifecycle_provider_status
    CHECK (provider_status IN ('not_required', 'pending', 'succeeded', 'failed')),
  CONSTRAINT check_staff_lifecycle_provider_failure_code
    CHECK (
      provider_failure_code IS NULL
      OR provider_failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
  CONSTRAINT check_staff_lifecycle_provider_state
    CHECK (
      (
        provider_action = 'none'
        AND provider_status = 'not_required'
        AND provider_attempt_count = 0
        AND provider_failure_code IS NULL
        AND provider_claim_token_hash IS NULL
        AND provider_claim_expires_at IS NULL
      )
      OR (
        provider_action IN ('disable', 'enable')
        AND provider_attempt_count >= 1
        AND (
          (
            provider_status = 'pending'
            AND provider_failure_code IS NULL
            AND provider_claim_token_hash ~ '^[0-9a-f]{64}$'
            AND provider_claim_expires_at IS NOT NULL
          )
          OR (
            provider_status = 'succeeded'
            AND provider_failure_code IS NULL
            AND provider_claim_token_hash IS NULL
            AND provider_claim_expires_at IS NULL
          )
          OR (
            provider_status = 'failed'
            AND provider_failure_code IS NOT NULL
            AND provider_claim_token_hash IS NULL
            AND provider_claim_expires_at IS NULL
          )
        )
      )
    )
);

CREATE INDEX staff_lifecycle_events_target_created_idx
  ON public.staff_lifecycle_events(target_admin_user_id, created_at DESC);
CREATE INDEX staff_lifecycle_events_provider_attention_idx
  ON public.staff_lifecycle_events(provider_status, provider_claim_expires_at)
  WHERE provider_status IN ('pending', 'failed');

ALTER TABLE public.staff_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE POLICY deny_staff_lifecycle_events_direct_access
  ON public.staff_lifecycle_events
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated, service_role
  USING (false)
  WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.staff_lifecycle_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.staff_lifecycle_events TO service_role;

-- Existing authenticated access tokens must stop reading catalog rows as soon as the durable
-- profile is deactivated. The caller can inspect only its own activation predicate; no target
-- identity or staff detail crosses this direct Data API boundary.
CREATE OR REPLACE FUNCTION public.staff_session_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users AS staff
    WHERE staff.auth_user_id = (SELECT auth.uid())
      AND staff.lifecycle_status = 'active'
      AND EXISTS (
        SELECT 1
        FROM public.user_roles AS role_row
        WHERE role_row.user_id = staff.id
          AND role_row.role IN ('admin', 'reviewer', 'editor')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.staff_provisioning_requests AS request
        WHERE request.admin_user_id = staff.id
          AND request.status = 'pending_activation'
      )
  );
$$;

REVOKE ALL ON FUNCTION public.staff_session_is_active()
  FROM PUBLIC, anon, authenticated, service_role;

DROP POLICY IF EXISTS select_programs_authenticated ON public.programs;
CREATE POLICY select_programs_authenticated ON public.programs
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_session_is_active()));

DROP POLICY IF EXISTS select_disciplines_authenticated ON public.disciplines;
CREATE POLICY select_disciplines_authenticated ON public.disciplines
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_session_is_active()));

DROP POLICY IF EXISTS select_industry_categories_authenticated ON public.industry_categories;
CREATE POLICY select_industry_categories_authenticated ON public.industry_categories
  FOR SELECT TO authenticated
  USING ((SELECT public.staff_session_is_active()));

CREATE OR REPLACE FUNCTION public.manage_staff_lifecycle(
  p_actor_admin_id uuid,
  p_target_email text,
  p_action text,
  p_roles text[],
  p_expected_version bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_email text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_target_email, '')));
  v_actor public.admin_users%ROWTYPE;
  v_target public.admin_users%ROWTYPE;
  v_roles text[];
  v_current_roles text[];
  v_next_roles text[];
  v_next_status text;
  v_event_action text;
  v_provider_action text := 'none';
  v_provider_status text := 'not_required';
  v_provider_token uuid;
  v_event_id uuid;
  v_effective_admin_count bigint;
  v_target_is_effective_admin boolean;
  v_target_pending_activation boolean;
BEGIN
  IF p_actor_admin_id IS NULL
    OR v_target_email = ''
    OR pg_catalog.length(v_target_email) > 254
    OR p_action IS NULL
    OR p_action NOT IN ('replace_roles', 'deactivate', 'reactivate')
    OR p_expected_version IS NULL
    OR p_expected_version < 1
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF p_action IN ('replace_roles', 'reactivate') THEN
    IF p_roles IS NULL
      OR pg_catalog.cardinality(p_roles) NOT BETWEEN 1 AND 3
      OR pg_catalog.array_position(p_roles, NULL) IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(p_roles) AS role_name
        WHERE pg_catalog.btrim(pg_catalog.lower(role_name))
          NOT IN ('admin', 'reviewer', 'editor')
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
    END IF;
    v_roles := public.canonical_staff_roles(p_roles);
  ELSIF p_roles IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- One global lock serializes every transition that can change the effective Administrator set.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capstone.staff_lifecycle_admin_invariant', 0)
  );

  SELECT * INTO v_actor
  FROM public.admin_users
  WHERE id = p_actor_admin_id
  FOR SHARE;

  IF NOT FOUND
    OR v_actor.auth_user_id IS NULL
    OR v_actor.lifecycle_status <> 'active'
    OR NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_actor_admin_id AND role = 'admin'
    )
    OR EXISTS (
      SELECT 1 FROM public.staff_provisioning_requests
      WHERE admin_user_id = p_actor_admin_id AND status = 'pending_activation'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  SELECT * INTO v_target
  FROM public.admin_users
  WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_target_email
  FOR UPDATE;

  IF NOT FOUND OR v_target.auth_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'TARGET_NOT_FOUND');
  END IF;
  IF v_target.id = p_actor_admin_id THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SELF_MODIFICATION_DENIED');
  END IF;
  IF v_target.lifecycle_version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'STALE_VERSION',
      'version', v_target.lifecycle_version
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.staff_provisioning_requests
    WHERE admin_user_id = v_target.id AND status = 'pending_activation'
  ) INTO v_target_pending_activation;

  IF EXISTS (
    SELECT 1
    FROM public.staff_lifecycle_events
    WHERE target_admin_user_id = v_target.id
      AND lifecycle_version = v_target.lifecycle_version
      AND provider_status IN ('pending', 'failed')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROVIDER_RECONCILIATION_REQUIRED');
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(
      role ORDER BY pg_catalog.array_position(
        ARRAY['admin', 'reviewer', 'editor']::text[], role
      )
    ),
    ARRAY[]::text[]
  ) INTO v_current_roles
  FROM public.user_roles
  WHERE user_id = v_target.id;

  v_target_is_effective_admin :=
    v_target.lifecycle_status = 'active'
    AND 'admin' = ANY(v_current_roles)
    AND NOT v_target_pending_activation;

  IF v_target_is_effective_admin
    AND (
      p_action = 'deactivate'
      OR (p_action = 'replace_roles' AND NOT ('admin' = ANY(v_roles)))
    )
  THEN
    SELECT pg_catalog.count(DISTINCT staff.id) INTO v_effective_admin_count
    FROM public.admin_users AS staff
    JOIN public.user_roles AS role_row
      ON role_row.user_id = staff.id AND role_row.role = 'admin'
    WHERE staff.lifecycle_status = 'active'
      AND staff.auth_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.staff_provisioning_requests AS request
        WHERE request.admin_user_id = staff.id AND request.status = 'pending_activation'
      );
    IF v_effective_admin_count <= 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'LAST_ADMIN_PROTECTED');
    END IF;
  END IF;

  CASE p_action
    WHEN 'replace_roles' THEN
      IF v_target.lifecycle_status <> 'active' THEN
        RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE');
      END IF;
      IF v_current_roles = v_roles THEN
        RETURN pg_catalog.jsonb_build_object(
          'resultCode', 'NO_CHANGE',
          'email', v_target_email,
          'status', CASE WHEN v_target_pending_activation
            THEN 'pending_activation' ELSE v_target.lifecycle_status END,
          'roles', pg_catalog.to_jsonb(v_current_roles),
          'version', v_target.lifecycle_version,
          'providerStatus', 'synchronized'
        );
      END IF;
      v_next_roles := v_roles;
      v_next_status := 'active';
      v_event_action := 'role_set_replaced';
    WHEN 'deactivate' THEN
      IF v_target.lifecycle_status = 'deactivated' THEN
        RETURN pg_catalog.jsonb_build_object(
          'resultCode', 'ALREADY_DEACTIVATED',
          'email', v_target_email,
          'status', v_target.lifecycle_status,
          'roles', pg_catalog.to_jsonb(v_current_roles),
          'version', v_target.lifecycle_version,
          'providerStatus', 'synchronized'
        );
      END IF;
      v_next_roles := ARRAY[]::text[];
      v_next_status := 'deactivated';
      v_event_action := 'deactivated';
      v_provider_action := 'disable';
      v_provider_status := 'pending';
    WHEN 'reactivate' THEN
      IF v_target.lifecycle_status = 'active' THEN
        IF v_current_roles = v_roles THEN
          RETURN pg_catalog.jsonb_build_object(
            'resultCode', 'ALREADY_ACTIVE',
            'email', v_target_email,
            'status', CASE WHEN v_target_pending_activation
              THEN 'pending_activation' ELSE v_target.lifecycle_status END,
            'roles', pg_catalog.to_jsonb(v_current_roles),
            'version', v_target.lifecycle_version,
            'providerStatus', 'synchronized'
          );
        END IF;
        RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE');
      END IF;
      v_next_roles := v_roles;
      v_next_status := 'active';
      v_event_action := 'reactivated';
      v_provider_action := 'enable';
      v_provider_status := 'pending';
  END CASE;

  DELETE FROM public.user_roles WHERE user_id = v_target.id;
  INSERT INTO public.user_roles(user_id, role)
  SELECT v_target.id, role_name
  FROM pg_catalog.unnest(v_next_roles) AS role_name;

  UPDATE public.admin_users
  SET lifecycle_status = v_next_status,
      lifecycle_version = lifecycle_version + 1,
      lifecycle_updated_at = pg_catalog.now(),
      deactivated_at = CASE
        WHEN v_next_status = 'deactivated' THEN pg_catalog.now()
        ELSE NULL
      END
  WHERE id = v_target.id
  RETURNING lifecycle_version INTO v_target.lifecycle_version;

  IF v_provider_action <> 'none' THEN
    v_provider_token := gen_random_uuid();
  END IF;

  INSERT INTO public.staff_lifecycle_events(
    target_admin_user_id, actor_admin_user_id,
    target_email_snapshot, target_full_name_snapshot,
    actor_email_snapshot, actor_full_name_snapshot,
    action, previous_status, next_status, previous_roles, next_roles, lifecycle_version,
    provider_action, provider_status, provider_attempt_count,
    provider_claim_token_hash, provider_claim_expires_at
  ) VALUES (
    v_target.id, v_actor.id,
    v_target_email, COALESCE(v_target.full_name, ''),
    pg_catalog.lower(pg_catalog.btrim(v_actor.email)), COALESCE(v_actor.full_name, ''),
    v_event_action, v_target.lifecycle_status, v_next_status,
    v_current_roles, v_next_roles, v_target.lifecycle_version,
    v_provider_action, v_provider_status,
    CASE WHEN v_provider_action = 'none' THEN 0 ELSE 1 END,
    CASE WHEN v_provider_action = 'none' THEN NULL ELSE pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_provider_token::text, 'UTF8'), 'sha256'),
      'hex'
    ) END,
    CASE WHEN v_provider_action = 'none' THEN NULL ELSE pg_catalog.now() + interval '2 minutes' END
  ) RETURNING id INTO v_event_id;

  RETURN pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'resultCode', 'UPDATED',
    'email', v_target_email,
    'status', CASE
      WHEN v_next_status = 'deactivated' THEN 'deactivated'
      WHEN v_target_pending_activation THEN 'pending_activation'
      ELSE 'active'
    END,
    'roles', pg_catalog.to_jsonb(v_next_roles),
    'version', v_target.lifecycle_version,
    'providerStatus', CASE WHEN v_provider_status = 'pending' THEN 'pending' ELSE 'synchronized' END,
    'providerAction', v_provider_action,
    'eventId', CASE WHEN v_provider_action = 'none' THEN NULL ELSE v_event_id::text END,
    'reconciliationToken', CASE WHEN v_provider_action = 'none' THEN NULL ELSE v_provider_token::text END,
    'authUserId', CASE WHEN v_provider_action = 'none' THEN NULL ELSE v_target.auth_user_id::text END
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_staff_provider_reconciliation(
  p_actor_admin_id uuid,
  p_target_email text,
  p_expected_version bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_email text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_target_email, '')));
  v_actor public.admin_users%ROWTYPE;
  v_target public.admin_users%ROWTYPE;
  v_event public.staff_lifecycle_events%ROWTYPE;
  v_roles text[];
  v_token uuid;
  v_target_pending_activation boolean;
BEGIN
  IF p_actor_admin_id IS NULL OR v_target_email = '' OR p_expected_version IS NULL
    OR p_expected_version < 1
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capstone.staff_lifecycle_admin_invariant', 0)
  );

  SELECT * INTO v_actor FROM public.admin_users
  WHERE id = p_actor_admin_id FOR SHARE;
  IF NOT FOUND
    OR v_actor.auth_user_id IS NULL
    OR v_actor.lifecycle_status <> 'active'
    OR NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = p_actor_admin_id AND role = 'admin'
    )
    OR EXISTS (
      SELECT 1 FROM public.staff_provisioning_requests
      WHERE admin_user_id = p_actor_admin_id AND status = 'pending_activation'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  SELECT * INTO v_target FROM public.admin_users
  WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_target_email
  FOR UPDATE;
  IF NOT FOUND OR v_target.auth_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'TARGET_NOT_FOUND');
  END IF;
  IF v_target.id = p_actor_admin_id THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SELF_MODIFICATION_DENIED');
  END IF;
  IF v_target.lifecycle_version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'STALE_VERSION', 'version', v_target.lifecycle_version
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.staff_provisioning_requests
    WHERE admin_user_id = v_target.id AND status = 'pending_activation'
  ) INTO v_target_pending_activation;

  SELECT * INTO v_event
  FROM public.staff_lifecycle_events
  WHERE target_admin_user_id = v_target.id
    AND lifecycle_version = v_target.lifecycle_version
    AND provider_action IN ('disable', 'enable')
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOTHING_TO_RECONCILE');
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(
      role ORDER BY pg_catalog.array_position(
        ARRAY['admin', 'reviewer', 'editor']::text[], role
      )
    ),
    ARRAY[]::text[]
  ) INTO v_roles
  FROM public.user_roles
  WHERE user_id = v_target.id;

  IF v_event.provider_status = 'succeeded' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_SYNCHRONIZED',
      'email', v_target_email,
      'status', CASE
        WHEN v_target.lifecycle_status = 'deactivated' THEN 'deactivated'
        WHEN v_target_pending_activation THEN 'pending_activation'
        ELSE 'active'
      END,
      'roles', pg_catalog.to_jsonb(v_roles),
      'version', v_target.lifecycle_version,
      'providerStatus', 'synchronized'
    );
  END IF;
  IF v_event.provider_status = 'pending'
    AND v_event.provider_claim_expires_at > pg_catalog.now()
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'IN_PROGRESS');
  END IF;

  v_token := gen_random_uuid();
  UPDATE public.staff_lifecycle_events
  SET provider_status = 'pending',
      provider_failure_code = NULL,
      provider_attempt_count = provider_attempt_count + 1,
      provider_claim_token_hash = pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(v_token::text, 'UTF8'), 'sha256'), 'hex'
      ),
      provider_claim_expires_at = pg_catalog.now() + interval '2 minutes',
      provider_updated_at = pg_catalog.now()
  WHERE id = v_event.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'CLAIMED',
    'email', v_target_email,
    'status', CASE
      WHEN v_target.lifecycle_status = 'deactivated' THEN 'deactivated'
      WHEN v_target_pending_activation THEN 'pending_activation'
      ELSE 'active'
    END,
    'roles', pg_catalog.to_jsonb(v_roles),
    'version', v_target.lifecycle_version,
    'providerStatus', 'pending',
    'providerAction', v_event.provider_action,
    'eventId', v_event.id::text,
    'reconciliationToken', v_token::text,
    'authUserId', v_target.auth_user_id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_staff_provider_reconciliation(
  p_event_id uuid,
  p_reconciliation_token uuid,
  p_succeeded boolean,
  p_failure_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.staff_lifecycle_events%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR p_reconciliation_token IS NULL OR p_succeeded IS NULL
    OR (p_succeeded AND p_failure_code IS NOT NULL)
    OR (
      NOT p_succeeded
      AND (
        p_failure_code IS NULL
        OR pg_catalog.regexp_match(p_failure_code, '^[A-Z][A-Z0-9_]{0,63}$') IS NULL
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_event
  FROM public.staff_lifecycle_events
  WHERE id = p_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EVENT_NOT_FOUND');
  END IF;
  IF v_event.provider_status <> 'pending'
    OR v_event.provider_claim_token_hash IS DISTINCT FROM pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(p_reconciliation_token::text, 'UTF8'), 'sha256'
      ),
      'hex'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_MISMATCH');
  END IF;
  IF v_event.provider_claim_expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_EXPIRED');
  END IF;

  UPDATE public.staff_lifecycle_events
  SET provider_status = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
      provider_failure_code = CASE WHEN p_succeeded THEN NULL ELSE p_failure_code END,
      provider_claim_token_hash = NULL,
      provider_claim_expires_at = NULL,
      provider_updated_at = pg_catalog.now()
  WHERE id = v_event.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RECORDED',
    'providerStatus', CASE WHEN p_succeeded THEN 'synchronized' ELSE 'attention_required' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.manage_staff_lifecycle(uuid, text, text, text[], bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_staff_lifecycle(uuid, text, text, text[], bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_staff_provider_reconciliation(uuid, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_staff_provider_reconciliation(uuid, text, bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_staff_provider_reconciliation(uuid, uuid, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_staff_provider_reconciliation(uuid, uuid, boolean, text)
  TO service_role;

-- This immutable, read-only stamp is installed atomically with every Migration 0053 capability.
-- Readiness compares the entire bounded value rather than trusting environment-supplied schema
-- assertions. Gate 3/4 remain the independent proof of complete migration history and no drift.
CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT '20260909120000_staff_lifecycle_readiness|active_staff_catalog_rls_v1|staff_lifecycle_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()
  TO service_role;

-- Keep the direct authenticated grant after service-role RPC declarations so the static
-- application-RPC manifest parser cannot misclassify this RLS-only helper.
GRANT EXECUTE ON FUNCTION public.staff_session_is_active() TO authenticated;

COMMIT;
