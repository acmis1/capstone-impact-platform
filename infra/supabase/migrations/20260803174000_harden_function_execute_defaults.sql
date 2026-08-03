-- Admin/CMS default function execution privilege hardening
-- 0007_harden_function_execute_defaults.sql

BEGIN;

-- Establish a global postgres-owned function default privilege rule (no IN SCHEMA clause).
-- Revokes default EXECUTE privileges on future functions from all Data API roles and PUBLIC.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC, anon, authenticated, service_role;

-- Revoke EXECUTE privileges on hosted event-trigger helper if present in target environment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rls_auto_enable'
      AND p.pronargs = 0
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END $$;

COMMIT;
