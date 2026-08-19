-- Migration 0029: durable password-recovery session provenance.
--
-- The signed application cookie authorizes only the short-lived reset form. This ledger is the
-- authoritative Admin gate for the lifetime of the exact Supabase Auth session. Its row is owned
-- by the Auth session and is deleted only through the Auth foreign-key cascades.

BEGIN;

CREATE TABLE public.password_recovery_sessions (
  session_id uuid PRIMARY KEY
    CONSTRAINT password_recovery_sessions_session_fk
    REFERENCES auth.sessions(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL
    CONSTRAINT password_recovery_sessions_auth_user_fk
    REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'password_recovery',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT check_password_recovery_session_purpose
    CHECK (purpose = 'password_recovery')
);

ALTER TABLE public.password_recovery_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY deny_password_recovery_sessions_direct_access
  ON public.password_recovery_sessions
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated, service_role
  USING (false)
  WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.password_recovery_sessions
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.register_password_recovery_session(
  p_session_id uuid,
  p_auth_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_user_id uuid;
  v_existing_auth_user_id uuid;
  v_existing_purpose text;
BEGIN
  IF p_session_id IS NULL OR p_auth_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT s.user_id
    INTO v_session_user_id
    FROM auth.sessions AS s
   WHERE s.id = p_session_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SESSION_NOT_FOUND');
  END IF;

  IF v_session_user_id IS DISTINCT FROM p_auth_user_id THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SESSION_USER_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM auth.users AS u
     WHERE u.id = p_auth_user_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  INSERT INTO public.password_recovery_sessions (session_id, auth_user_id, purpose)
  VALUES (p_session_id, p_auth_user_id, 'password_recovery')
  ON CONFLICT (session_id) DO NOTHING;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'REGISTERED');
  END IF;

  SELECT prs.auth_user_id, prs.purpose
    INTO v_existing_auth_user_id, v_existing_purpose
    FROM public.password_recovery_sessions AS prs
   WHERE prs.session_id = p_session_id;

  IF FOUND
     AND v_existing_auth_user_id IS NOT DISTINCT FROM p_auth_user_id
     AND v_existing_purpose = 'password_recovery'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_REGISTERED');
  END IF;

  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

REVOKE ALL ON FUNCTION public.register_password_recovery_session(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_password_recovery_session(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_current_password_recovery_session_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claims jsonb;
  v_auth_user_id uuid;
  v_session_id_text text;
  v_session_id uuid;
  v_session_user_id uuid;
BEGIN
  v_claims := auth.jwt();
  v_auth_user_id := auth.uid();

  IF v_auth_user_id IS NULL
     OR v_claims IS NULL
     OR pg_catalog.jsonb_typeof(v_claims) <> 'object'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_CONTEXT');
  END IF;

  v_session_id_text := v_claims ->> 'session_id';
  IF v_session_id_text IS NULL OR v_session_id_text = '' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_CONTEXT');
  END IF;

  BEGIN
    v_session_id := v_session_id_text::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_CONTEXT');
  END;

  SELECT s.user_id
    INTO v_session_user_id
    FROM auth.sessions AS s
   WHERE s.id = v_session_id;

  IF FOUND AND v_session_user_id IS DISTINCT FROM v_auth_user_id THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_CONTEXT');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.password_recovery_sessions AS prs
      JOIN auth.sessions AS s
        ON s.id = prs.session_id
       AND s.user_id = prs.auth_user_id
     WHERE prs.session_id = v_session_id
       AND prs.auth_user_id = v_auth_user_id
       AND prs.purpose = 'password_recovery'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'RECOVERY_SESSION');
  END IF;

  RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_REGISTERED');
END;
$$;

REVOKE ALL ON FUNCTION public.get_current_password_recovery_session_state()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_current_password_recovery_session_state()
  TO authenticated;

COMMIT;
