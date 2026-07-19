-- Staging database schema: initial admin bootstrap function
-- 0005_initial_admin_bootstrap.sql (Idempotent & Transactional)

BEGIN;

CREATE OR REPLACE FUNCTION public.bootstrap_initial_admin(
  p_auth_user_id uuid,
  p_email text,
  p_full_name text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_normalized_email text;
    v_trimmed_full_name text;
    v_auth_exists boolean;
    v_auth_email text;
    v_admin_users_count integer;
    v_user_roles_count integer;
    v_existing_profile_id uuid;
    v_existing_profile_email text;
    v_existing_profile_auth_id uuid;
    v_has_admin_role boolean;
BEGIN
    -- Acquire transaction-scoped advisory lock before checking counts or inserting
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'capstone.bootstrap_initial_admin',
        0
      )
    );

    -- Reject null or empty inputs
    IF p_auth_user_id IS NULL THEN
        RAISE EXCEPTION 'AUTH_USER_ID_REQUIRED';
    END IF;
    IF p_email IS NULL OR pg_catalog.trim(p_email) = '' THEN
        RAISE EXCEPTION 'EMAIL_REQUIRED';
    END IF;
    IF p_full_name IS NULL OR pg_catalog.trim(p_full_name) = '' THEN
        RAISE EXCEPTION 'FULL_NAME_REQUIRED';
    END IF;

    -- Normalize email and full name
    v_normalized_email := pg_catalog.lower(pg_catalog.trim(p_email));
    v_trimmed_full_name := pg_catalog.trim(p_full_name);

    -- Verify the supplied auth user ID exists in auth.users
    SELECT EXISTS (
        SELECT 1 FROM auth.users WHERE id = p_auth_user_id
    ) INTO v_auth_exists;

    IF NOT v_auth_exists THEN
        RAISE EXCEPTION 'AUTH_USER_NOT_FOUND';
    END IF;

    -- Verify the supplied email matches that Auth user (both normalized)
    SELECT pg_catalog.lower(pg_catalog.trim(email))
    INTO v_auth_email
    FROM auth.users
    WHERE id = p_auth_user_id;

    IF v_auth_email IS DISTINCT FROM v_normalized_email THEN
        RAISE EXCEPTION 'AUTH_EMAIL_MISMATCH';
    END IF;

    -- Count existing admin profiles and roles
    SELECT pg_catalog.count(*) INTO v_admin_users_count FROM public.admin_users;
    SELECT pg_catalog.count(*) INTO v_user_roles_count FROM public.user_roles;

    -- Check if we are in Fresh State
    IF v_admin_users_count = 0 AND v_user_roles_count = 0 THEN
        -- Create one linked admin_users row
        INSERT INTO public.admin_users (email, full_name, auth_user_id)
        VALUES (v_normalized_email, v_trimmed_full_name, p_auth_user_id)
        RETURNING id INTO v_existing_profile_id;

        -- Create one admin role row
        INSERT INTO public.user_roles (user_id, role)
        VALUES (v_existing_profile_id, 'admin');

        RETURN 'CREATED';
    END IF;

    -- If not fresh, we require exactly one administrator row to exist.
    IF v_admin_users_count = 1 THEN
        SELECT
          id,
          pg_catalog.lower(pg_catalog.trim(email)),
          auth_user_id 
        INTO
          v_existing_profile_id,
          v_existing_profile_email,
          v_existing_profile_auth_id
        FROM public.admin_users;

        -- Check if it matches the supplied auth user
        IF v_existing_profile_auth_id = p_auth_user_id AND v_existing_profile_email = v_normalized_email THEN
            -- Check if it has the admin role
            SELECT EXISTS (
                SELECT 1 FROM public.user_roles 
                WHERE user_id = v_existing_profile_id AND role = 'admin'
            ) INTO v_has_admin_role;

            -- If it has the admin role and no other roles
            IF v_has_admin_role AND v_user_roles_count = 1 THEN
                RETURN 'ALREADY_PROVISIONED';
            END IF;

            -- If it has no roles
            IF NOT v_has_admin_role AND v_user_roles_count = 0 THEN
                INSERT INTO public.user_roles (user_id, role)
                VALUES (v_existing_profile_id, 'admin');
                RETURN 'ROLE_REPAIRED';
            END IF;
        END IF;
    END IF;

    -- Any other state or mismatch raises a controlled exception
    RAISE EXCEPTION 'BOOTSTRAP_PRECONDITION_FAILED';
END;
$$;

-- Revoke default function execution and grant explicitly to service_role only
REVOKE EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) TO service_role;

COMMIT;
