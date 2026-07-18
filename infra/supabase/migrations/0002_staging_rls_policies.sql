-- Staging database RLS (Row-Level Security) policies
-- 0002_staging_rls_policies.sql (Corrected & Idempotent)

-- ⚠️ WARNING & SECURITY NOTICE:
-- 1. These RLS policies are staging-only foundations. The final production RLS rules must be confirmed later.
-- 2. Service role operations (e.g. backend operations using createSupabaseAdminClient()) completely bypass RLS.
-- 3. To maintain strict security and data control, all admin/CMS data access should go exclusively through server API routes using the service role until robust RBAC/claims policies are finalized.
-- 4. Browser clients must NOT access internal admin/CMS tables directly. Consequently, direct authenticated access to projects, validation_flags, and approval_records is disabled by default.
-- 5. The public showcase site (Duda) should be served exclusively from stable, approved public feed JSON files in public storage buckets, not direct table reads.

-- Enable Row-Level Security on all tables
ALTER TABLE programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE disciplines ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_disciplines ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_industry_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_snapshots ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- 1. LOOKUP TABLES (programs, disciplines, industry_categories)
-- ==========================================
-- Allow authenticated staging users to read lookup values if needed for reference

DROP POLICY IF EXISTS select_programs_authenticated ON programs;
CREATE POLICY select_programs_authenticated ON programs
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS select_disciplines_authenticated ON disciplines;
CREATE POLICY select_disciplines_authenticated ON disciplines
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS select_industry_categories_authenticated ON industry_categories;
CREATE POLICY select_industry_categories_authenticated ON industry_categories
    FOR SELECT TO authenticated USING (true);

-- ==========================================
-- 2. RESTRICTIVE STAGING PLACEHOLDERS FOR ADMIN OPERATIONS
-- ==========================================
-- All operations on internal tables (projects, validation_flags, audit_records, media_assets, snapshots, roles)
-- by standard authenticated browser clients are blocked by default. Standard operations bypass RLS entirely
-- via the backend service_role key.
-- Do not add broad "using (true)" policies on internal admin tables.

DROP POLICY IF EXISTS admin_all_programs ON programs;
CREATE POLICY admin_all_programs ON programs
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_disciplines ON disciplines;
CREATE POLICY admin_all_disciplines ON disciplines
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_industry_categories ON industry_categories;
CREATE POLICY admin_all_industry_categories ON industry_categories
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_admin_users ON admin_users;
CREATE POLICY admin_all_admin_users ON admin_users
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_user_roles ON user_roles;
CREATE POLICY admin_all_user_roles ON user_roles
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_import_batches ON import_batches;
CREATE POLICY admin_all_import_batches ON import_batches
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_projects ON projects;
CREATE POLICY admin_all_projects ON projects
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_project_disciplines ON project_disciplines;
CREATE POLICY admin_all_project_disciplines ON project_disciplines
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_project_industry_categories ON project_industry_categories;
CREATE POLICY admin_all_project_industry_categories ON project_industry_categories
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_media_assets ON media_assets;
CREATE POLICY admin_all_media_assets ON media_assets
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_validation_flags ON validation_flags;
CREATE POLICY admin_all_validation_flags ON validation_flags
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_approval_records ON approval_records;
CREATE POLICY admin_all_approval_records ON approval_records
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS admin_all_published_snapshots ON published_snapshots;
CREATE POLICY admin_all_published_snapshots ON published_snapshots
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- ==========================================
-- 3. NO ANONYMOUS ACCESS BY DEFAULT
-- ==========================================
-- No anonymous public table reads or writes. This guarantees database security from direct browser manipulation.
