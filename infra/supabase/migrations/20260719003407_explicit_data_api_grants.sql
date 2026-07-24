-- Admin/CMS explicit least-privilege Data API grants
-- 0004_explicit_data_api_grants.sql
--
-- This migration is intentionally separate from schema and RLS creation.
-- Postgres grants control whether a Data API role can reach an object.
-- RLS controls which rows an already-authorized role may access.
--
-- Intended model:
-- - anon: no Admin/CMS table access
-- - authenticated: read-only lookup-table access
-- - service_role: server-only CRUD access
--
-- Do not use service-role or secret keys in browser code.

BEGIN;

-- Keep future public-schema objects opt-in rather than automatically exposed.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC;

-- Ensure Data API roles have schema usage where required.
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- Remove any pre-existing table privileges so this migration defines the
-- complete current access contract.
REVOKE ALL PRIVILEGES ON TABLE
  public.programs,
  public.disciplines,
  public.industry_categories,
  public.admin_users,
  public.user_roles,
  public.import_batches,
  public.projects,
  public.project_disciplines,
  public.project_industry_categories,
  public.media_assets,
  public.validation_flags,
  public.approval_records,
  public.published_snapshots
FROM anon, authenticated, service_role;

-- Browser-authenticated users may read only non-sensitive lookup data.
GRANT SELECT ON TABLE
  public.programs,
  public.disciplines,
  public.industry_categories
TO authenticated;

-- All Admin/CMS relational operations run through server-only code.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.programs,
  public.disciplines,
  public.industry_categories,
  public.admin_users,
  public.user_roles,
  public.import_batches,
  public.projects,
  public.project_disciplines,
  public.project_industry_categories,
  public.media_assets,
  public.validation_flags,
  public.approval_records,
  public.published_snapshots
TO service_role;

-- This trigger helper must not be available as a callable Data API RPC.
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column()
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
