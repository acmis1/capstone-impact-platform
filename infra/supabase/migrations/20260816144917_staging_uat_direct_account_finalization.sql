-- Migration 0027: atomic finalization for staging UAT password accounts.
--
-- Direct-created Auth identities already have a confirmed email and password. This service-role
-- function therefore performs profile creation, non-admin role assignment, and lifecycle
-- activation in one PostgreSQL statement transaction. Any raised database error rolls every
-- mutation back to the owned `invited` state, where the existing marker-fenced compensation flow
-- remains authorized. Invitation onboarding continues to use the separate finalize + activate
-- lifecycle from Migration 0022.

BEGIN;

-- GoTrue's admin createUser flow may apply user metadata again after inserting auth.users.
-- Reuse Migration 0022's marker-fenced trigger for that update so the raw request/token fields
-- are consumed regardless of whether the provider writes them during INSERT or UPDATE.
DROP TRIGGER IF EXISTS claim_staff_provisioning_auth_insert_before_metadata_update ON auth.users;
CREATE TRIGGER claim_staff_provisioning_auth_insert_before_metadata_update
BEFORE UPDATE OF raw_user_meta_data ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.claim_staff_provisioning_auth_insert();

CREATE OR REPLACE FUNCTION public.finalize_and_activate_staff_provisioning(
  p_request_id uuid,
  p_execution_token uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_request public.staff_provisioning_requests%ROWTYPE;
  v_auth_email text;
  v_auth_marker text;
  v_admin_user_id uuid;
BEGIN
  IF p_request_id IS NULL OR p_execution_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_request
  FROM public.staff_provisioning_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'REQUEST_NOT_FOUND');
  END IF;
  IF v_request.execution_token_hash IS DISTINCT FROM pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_execution_token::text, 'UTF8'), 'sha256'),
    'hex'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_TOKEN_MISMATCH');
  END IF;
  IF v_request.lease_expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_LEASE_EXPIRED');
  END IF;
  IF v_request.status <> 'invited'
     OR v_request.auth_user_id IS NULL
     OR v_request.auth_identity_owned = false
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE');
  END IF;

  -- This RPC is never an Administrator creation path, even if an application caller is forged.
  IF pg_catalog.cardinality(v_request.requested_roles) NOT BETWEEN 1 AND 2
     OR pg_catalog.array_position(v_request.requested_roles, NULL) IS NOT NULL
     OR NOT (v_request.requested_roles <@ ARRAY['reviewer', 'editor']::text[])
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ROLE_NOT_ALLOWED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'capstone.staff_provisioning:' || v_request.normalized_email,
      0
    )
  );

  SELECT
    pg_catalog.lower(pg_catalog.btrim(email)),
    raw_app_meta_data->>'staff_provisioning_marker'
  INTO v_auth_email, v_auth_marker
  FROM auth.users
  WHERE id = v_request.auth_user_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AUTH_USER_NOT_FOUND');
  END IF;
  IF v_auth_email IS DISTINCT FROM v_request.normalized_email THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AUTH_EMAIL_MISMATCH');
  END IF;
  IF v_auth_marker IS DISTINCT FROM pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_request.id::text, 'UTF8'), 'sha256'),
    'hex'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AUTH_OWNERSHIP_MISMATCH');
  END IF;

  -- Reject either side of a split email/Auth collision before reusing an existing profile.
  IF EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_request.normalized_email
      AND auth_user_id IS DISTINCT FROM v_request.auth_user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE auth_user_id = v_request.auth_user_id
      AND pg_catalog.lower(pg_catalog.btrim(email)) IS DISTINCT FROM v_request.normalized_email
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_PROVISIONED');
  END IF;

  SELECT id INTO v_admin_user_id
  FROM public.admin_users
  WHERE pg_catalog.lower(pg_catalog.btrim(email)) = v_request.normalized_email
    AND auth_user_id = v_request.auth_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.admin_users(email, full_name, auth_user_id)
    VALUES (v_request.normalized_email, v_request.full_name, v_request.auth_user_id)
    RETURNING id INTO v_admin_user_id;
  END IF;

  INSERT INTO public.user_roles(user_id, role)
  SELECT v_admin_user_id, role_name
  FROM pg_catalog.unnest(v_request.requested_roles) role_name
  ON CONFLICT ON CONSTRAINT unique_user_role DO NOTHING;

  UPDATE public.staff_provisioning_requests
  SET admin_user_id = v_admin_user_id,
      status = 'activated',
      activated_at = pg_catalog.now(),
      updated_at = pg_catalog.now(),
      lease_expires_at = pg_catalog.now()
  WHERE id = v_request.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'adminUserId', v_admin_user_id::text,
    'status', 'activated'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_and_activate_staff_provisioning(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_and_activate_staff_provisioning(uuid, uuid)
  TO service_role;

COMMIT;
