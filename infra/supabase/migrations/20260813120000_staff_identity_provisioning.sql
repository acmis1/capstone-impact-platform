-- Migration 0022: controlled staff identity provisioning.
--
-- Supabase Auth and PostgreSQL are separate systems and cannot share one transaction, so this
-- migration introduces an explicit, durable state machine instead of pretending they can.
--
-- Durable lifecycle:
--   reserved            -> the normalized target identity is exclusively reserved for one
--                          provisioning attempt; nothing has been created in Auth yet
--   invited             -> an Auth identity exists and is bound to this exact attempt
--   pending_activation  -> the Admin/CMS staff profile and role rows exist, but the identity is
--                          deliberately NOT yet usable; the centralized staff resolver denies it
--   activated           -> the invitee completed account setup; the identity is usable staff
--   failed              -> the attempt stopped safely; any Auth identity this attempt created
--                          was compensated away
--   compensation_failed -> the attempt stopped and compensation itself could not complete; this
--                          state is fail-closed and retained as operational evidence
--
-- `bootstrap_initial_admin` is untouched by this migration. It remains the first-administrator
-- bootstrap only; every additional staff member goes through this workflow.
--
-- Authority: only an existing, fully activated administrator may reserve a provisioning attempt.
-- The browser can never supply the acting administrator, the target Auth identity, the
-- provisioning status, or any audit attribution -- every privileged function here is
-- service_role only and derives its own evidence from authoritative database state.
--
-- Secrets: no password, invitation token, magic-link token, session token or service-role key is
-- ever accepted, stored or returned by anything in this migration. `failure_code` is constrained
-- to a bounded uppercase operational code so free-form text can never smuggle a secret in.

BEGIN;

CREATE TABLE public.staff_provisioning_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email text NOT NULL,
  full_name text NOT NULL,
  requested_roles text[] NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
    CONSTRAINT check_staff_provisioning_status CHECK (
      status IN ('reserved', 'invited', 'pending_activation', 'activated', 'failed', 'compensation_failed')
    ),
  requested_by_admin_id uuid REFERENCES public.admin_users(id) ON DELETE SET NULL,
  requested_by_full_name_snapshot text,
  requested_by_email_snapshot text,
  -- Deliberately NOT a foreign key to auth.users. When a failed attempt is compensated the Auth
  -- identity is deleted, and the binding must survive as immutable evidence of what happened.
  auth_user_id uuid,
  -- Proven, not asserted: set only when the bound Auth identity was created at or after this
  -- attempt reserved the target. Compensation may delete an Auth identity only when this is true,
  -- so a pre-existing Auth user can never be destroyed by a failed provisioning attempt.
  auth_identity_created boolean NOT NULL DEFAULT false,
  admin_user_id uuid REFERENCES public.admin_users(id) ON DELETE SET NULL,
  failure_code text
    CONSTRAINT check_staff_provisioning_failure_code CHECK (
      failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  invited_at timestamptz,
  activated_at timestamptz,
  CONSTRAINT check_staff_provisioning_roles CHECK (
    pg_catalog.cardinality(requested_roles) BETWEEN 1 AND 3
    AND pg_catalog.array_position(requested_roles, NULL) IS NULL
    AND requested_roles <@ ARRAY['admin', 'reviewer', 'editor']::text[]
  ),
  CONSTRAINT check_staff_provisioning_terminal_binding CHECK (
    (status = 'reserved' AND auth_user_id IS NULL AND admin_user_id IS NULL)
    OR (status = 'invited' AND auth_user_id IS NOT NULL AND admin_user_id IS NULL)
    OR (status IN ('pending_activation', 'activated') AND auth_user_id IS NOT NULL AND admin_user_id IS NOT NULL)
    OR status IN ('failed', 'compensation_failed')
  )
);

CREATE INDEX staff_provisioning_requests_email_idx
  ON public.staff_provisioning_requests(normalized_email);
CREATE INDEX staff_provisioning_requests_admin_user_idx
  ON public.staff_provisioning_requests(admin_user_id);

-- Exactly one non-terminal or successful lifecycle may exist per normalized identity. This is the
-- authoritative convergence guarantee: duplicate submits, sequential retries and concurrent
-- requests for case/whitespace-equivalent addresses can never produce two live lifecycles.
CREATE UNIQUE INDEX staff_provisioning_requests_active_email_uidx
  ON public.staff_provisioning_requests(normalized_email)
  WHERE status IN ('reserved', 'invited', 'pending_activation', 'activated');

-- One live lifecycle per bound Auth identity, so a second attempt can never adopt an identity
-- that already belongs to another provisioning record.
CREATE UNIQUE INDEX staff_provisioning_requests_active_auth_user_uidx
  ON public.staff_provisioning_requests(auth_user_id)
  WHERE auth_user_id IS NOT NULL AND status IN ('invited', 'pending_activation', 'activated');

ALTER TABLE public.staff_provisioning_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_all_staff_provisioning_requests ON public.staff_provisioning_requests
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.staff_provisioning_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.staff_provisioning_requests TO service_role;

-- Canonical role order is a domain rule, declared authority-descending and deliberately not
-- alphabetical. It is defined once here so stored roles, audit evidence and the application's
-- resolved permission union can never disagree about ordering.
CREATE OR REPLACE FUNCTION public.canonical_staff_roles(p_roles text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.array_agg(r ORDER BY pg_catalog.array_position(ARRAY['admin', 'reviewer', 'editor']::text[], r))
  FROM (SELECT DISTINCT pg_catalog.btrim(pg_catalog.lower(x)) AS r FROM pg_catalog.unnest(p_roles) x) s;
$$;

REVOKE ALL ON FUNCTION public.canonical_staff_roles(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canonical_staff_roles(text[]) TO service_role;

-- Step C of the workflow: atomically reserve the normalized target identity before anything is
-- created in Supabase Auth.
CREATE OR REPLACE FUNCTION public.reserve_staff_provisioning(
  p_actor_admin_id uuid,
  p_email text,
  p_full_name text,
  p_roles text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_full_name text := pg_catalog.btrim(COALESCE(p_full_name, ''));
  v_roles text[];
  v_actor_full_name text;
  v_actor_email text;
  v_existing public.staff_provisioning_requests%ROWTYPE;
  v_request public.staff_provisioning_requests%ROWTYPE;
BEGIN
  -- Authority is resolved from authoritative database state only.
  SELECT full_name, email INTO v_actor_full_name, v_actor_email
  FROM public.admin_users WHERE id = p_actor_admin_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor_admin_id AND role = 'admin'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- An administrator who has not completed their own activation cannot provision anyone.
  IF EXISTS (
    SELECT 1 FROM public.staff_provisioning_requests
    WHERE admin_user_id = p_actor_admin_id AND status = 'pending_activation'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  IF v_email = ''
    OR pg_catalog.length(v_email) > 254
    OR pg_catalog.regexp_match(v_email, '^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$') IS NULL
    OR v_full_name = ''
    OR pg_catalog.length(v_full_name) > 200
    OR p_roles IS NULL
    OR pg_catalog.cardinality(p_roles) = 0
    OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_roles) x
      WHERE x IS NULL OR pg_catalog.btrim(pg_catalog.lower(x)) NOT IN ('admin', 'reviewer', 'editor')
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  v_roles := public.canonical_staff_roles(p_roles);

  -- Serialize every attempt against the same normalized identity, including case/whitespace
  -- equivalents, before any existence check is read.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capstone.staff_provisioning:' || v_email, 0)
  );

  -- The live lifecycle is consulted before the staff profile, because a finalized invitation
  -- already owns an `admin_users` row while still awaiting activation. Checking the profile first
  -- would misreport that outstanding invitation as an existing account.
  SELECT * INTO v_existing FROM public.staff_provisioning_requests
  WHERE normalized_email = v_email
    AND status IN ('reserved', 'invited', 'pending_activation', 'activated')
  FOR UPDATE;

  IF NOT FOUND AND EXISTS (
    SELECT 1 FROM public.admin_users WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_email
  ) THEN
    -- A staff account exists with no provisioning lifecycle: the bootstrap administrator or a
    -- Local synthetic account. It is already provisioned and must not be re-invited.
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_PROVISIONED');
  END IF;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.status = 'activated' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_PROVISIONED');
    END IF;
    IF v_existing.status = 'pending_activation' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_INVITED');
    END IF;
    -- 'reserved' or 'invited': converge onto the one authoritative lifecycle rather than
    -- starting a competing one. The originally requested name and roles are returned so a retry
    -- can never silently rewrite the pending request.
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'RESUMED',
      'requestId', v_existing.id::text,
      'normalizedEmail', v_existing.normalized_email,
      'fullName', v_existing.full_name,
      'roles', pg_catalog.to_jsonb(v_existing.requested_roles),
      'authUserId', v_existing.auth_user_id::text,
      'authIdentityCreated', v_existing.auth_identity_created
    );
  END IF;

  INSERT INTO public.staff_provisioning_requests(
    normalized_email, full_name, requested_roles, status,
    requested_by_admin_id, requested_by_full_name_snapshot, requested_by_email_snapshot
  ) VALUES (
    v_email, v_full_name, v_roles, 'reserved',
    p_actor_admin_id, v_actor_full_name, v_actor_email
  ) RETURNING * INTO v_request;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RESERVED',
    'requestId', v_request.id::text,
    'normalizedEmail', v_request.normalized_email,
    'fullName', v_request.full_name,
    'roles', pg_catalog.to_jsonb(v_request.requested_roles),
    'authUserId', NULL,
    'authIdentityCreated', false
  );
END; $$;

REVOKE ALL ON FUNCTION public.reserve_staff_provisioning(uuid, text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_staff_provisioning(uuid, text, text, text[]) TO service_role;

-- Step E of the workflow: bind the exact Auth identity returned by the invitation to this exact
-- attempt, and prove whether this attempt is the one that created it.
CREATE OR REPLACE FUNCTION public.bind_staff_provisioning_identity(
  p_request_id uuid,
  p_auth_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_request public.staff_provisioning_requests%ROWTYPE;
  v_auth_email text;
  v_auth_created_at timestamptz;
  v_created_by_attempt boolean;
BEGIN
  IF p_request_id IS NULL OR p_auth_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_request FROM public.staff_provisioning_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'REQUEST_NOT_FOUND');
  END IF;

  IF v_request.status = 'invited' THEN
    -- Idempotent convergence: a concurrent attempt may already have bound this lifecycle.
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', CASE WHEN v_request.auth_user_id = p_auth_user_id THEN 'BOUND' ELSE 'ALREADY_BOUND' END,
      'authUserId', v_request.auth_user_id::text,
      'authIdentityCreated', v_request.auth_identity_created
    );
  END IF;

  IF v_request.status <> 'reserved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE', 'status', v_request.status);
  END IF;

  SELECT pg_catalog.lower(pg_catalog.btrim(email)), created_at
  INTO v_auth_email, v_auth_created_at
  FROM auth.users WHERE id = p_auth_user_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AUTH_USER_NOT_FOUND');
  END IF;

  IF v_auth_email IS DISTINCT FROM v_request.normalized_email THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AUTH_EMAIL_MISMATCH');
  END IF;

  v_created_by_attempt := v_auth_created_at >= v_request.created_at;

  UPDATE public.staff_provisioning_requests
     SET auth_user_id = p_auth_user_id,
         auth_identity_created = v_created_by_attempt,
         status = 'invited',
         invited_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE id = p_request_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'BOUND',
    'authUserId', p_auth_user_id::text,
    'authIdentityCreated', v_created_by_attempt
  );
END; $$;

REVOKE ALL ON FUNCTION public.bind_staff_provisioning_identity(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_staff_provisioning_identity(uuid, uuid) TO service_role;

-- Step F of the workflow: atomically create and bind the Admin/CMS staff profile and role rows.
-- The identity deliberately lands in 'pending_activation', NOT in a usable staff state.
CREATE OR REPLACE FUNCTION public.finalize_staff_provisioning(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_request public.staff_provisioning_requests%ROWTYPE;
  v_auth_email text;
  v_admin_user_id uuid;
  v_existing_auth_user_id uuid;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_request FROM public.staff_provisioning_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'REQUEST_NOT_FOUND');
  END IF;

  IF v_request.status IN ('pending_activation', 'activated') THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'SUCCESS',
      'adminUserId', v_request.admin_user_id::text,
      'status', v_request.status
    );
  END IF;

  IF v_request.status <> 'invited' OR v_request.auth_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE', 'status', v_request.status);
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capstone.staff_provisioning:' || v_request.normalized_email, 0)
  );

  -- Re-verify the Auth identity still exists and still matches the reserved target.
  SELECT pg_catalog.lower(pg_catalog.btrim(email)) INTO v_auth_email
  FROM auth.users WHERE id = v_request.auth_user_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AUTH_USER_NOT_FOUND');
  END IF;
  IF v_auth_email IS DISTINCT FROM v_request.normalized_email THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AUTH_EMAIL_MISMATCH');
  END IF;

  SELECT id, auth_user_id INTO v_admin_user_id, v_existing_auth_user_id
  FROM public.admin_users
  WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_request.normalized_email
     OR auth_user_id = v_request.auth_user_id
  LIMIT 1;

  IF FOUND THEN
    -- A staff profile already exists. Adopting it is only safe when it is the very identity this
    -- attempt invited; anything else is a collision and must fail closed.
    IF v_existing_auth_user_id IS DISTINCT FROM v_request.auth_user_id THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_PROVISIONED');
    END IF;
  ELSE
    INSERT INTO public.admin_users(email, full_name, auth_user_id)
    VALUES (v_request.normalized_email, v_request.full_name, v_request.auth_user_id)
    RETURNING id INTO v_admin_user_id;
  END IF;

  INSERT INTO public.user_roles(user_id, role)
  SELECT v_admin_user_id, r FROM pg_catalog.unnest(v_request.requested_roles) r
  ON CONFLICT ON CONSTRAINT unique_user_role DO NOTHING;

  UPDATE public.staff_provisioning_requests
     SET admin_user_id = v_admin_user_id,
         status = 'pending_activation',
         updated_at = pg_catalog.now()
   WHERE id = p_request_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'adminUserId', v_admin_user_id::text,
    'status', 'pending_activation'
  );
END; $$;

REVOKE ALL ON FUNCTION public.finalize_staff_provisioning(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_staff_provisioning(uuid) TO service_role;

-- Step H of the workflow: transition the identity into usable staff, bound to the EXACT invited
-- Auth identity. The caller supplies only an authenticated server-derived Auth ID; there is no
-- request identifier to forge and no way to activate somebody else's provisioning record.
CREATE OR REPLACE FUNCTION public.activate_staff_provisioning(p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_request public.staff_provisioning_requests%ROWTYPE;
  v_profile_auth_user_id uuid;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVATION_MISMATCH');
  END IF;

  SELECT * INTO v_request FROM public.staff_provisioning_requests
  WHERE auth_user_id = p_auth_user_id
    AND status IN ('pending_activation', 'activated')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVATION_MISMATCH');
  END IF;

  IF v_request.status = 'activated' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_ACTIVATED');
  END IF;

  SELECT auth_user_id INTO v_profile_auth_user_id
  FROM public.admin_users WHERE id = v_request.admin_user_id;

  IF NOT FOUND OR v_profile_auth_user_id IS DISTINCT FROM p_auth_user_id THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVATION_MISMATCH');
  END IF;

  UPDATE public.staff_provisioning_requests
     SET status = 'activated',
         activated_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE id = v_request.id;

  RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVATED');
END; $$;

REVOKE ALL ON FUNCTION public.activate_staff_provisioning(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_staff_provisioning(uuid) TO service_role;

-- Failure and compensation evidence. An activated lifecycle can never be retroactively failed.
CREATE OR REPLACE FUNCTION public.fail_staff_provisioning(
  p_request_id uuid,
  p_failure_code text,
  p_compensation_state text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_request public.staff_provisioning_requests%ROWTYPE;
  v_status text;
BEGIN
  IF p_request_id IS NULL
    OR p_compensation_state IS NULL
    OR p_compensation_state NOT IN ('not_required', 'succeeded', 'failed')
    OR p_failure_code IS NULL
    OR pg_catalog.regexp_match(p_failure_code, '^[A-Z][A-Z0-9_]{0,63}$') IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_request FROM public.staff_provisioning_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'REQUEST_NOT_FOUND');
  END IF;

  IF v_request.status = 'activated' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE', 'status', v_request.status);
  END IF;

  v_status := CASE WHEN p_compensation_state = 'failed' THEN 'compensation_failed' ELSE 'failed' END;

  UPDATE public.staff_provisioning_requests
     SET status = v_status,
         failure_code = p_failure_code,
         updated_at = pg_catalog.now()
   WHERE id = p_request_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', v_status,
    'authUserId', v_request.auth_user_id::text,
    'authIdentityCreated', v_request.auth_identity_created
  );
END; $$;

REVOKE ALL ON FUNCTION public.fail_staff_provisioning(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_staff_provisioning(uuid, text, text) TO service_role;

COMMIT;
