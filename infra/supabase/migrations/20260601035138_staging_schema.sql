-- Staging database schema foundation for capstone-admin-cms-staging-2026 Supabase project
-- 0001_staging_schema.sql (Idempotent)

-- Enable pgcrypto for gen_random_uuid() and uuid-ossp
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Programs table
CREATE TABLE IF NOT EXISTS programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Disciplines table
CREATE TABLE IF NOT EXISTS disciplines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Industry Categories table
CREATE TABLE IF NOT EXISTS industry_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Admin Users table
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    full_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- User Roles table
CREATE TABLE IF NOT EXISTS user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CONSTRAINT check_user_role CHECK (role IN ('admin', 'reviewer', 'editor')),
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT unique_user_role UNIQUE (user_id, role)
);

-- Import Batches table
CREATE TABLE IF NOT EXISTS import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_name TEXT,
    mode TEXT DEFAULT 'unknown' CONSTRAINT check_import_mode CHECK (mode IN ('single', 'batch', 'manual', 'unknown')),
    source_folder TEXT,
    imported_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT check_batch_status CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    total_projects INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_id TEXT UNIQUE NOT NULL, -- BigInt/Text deterministic public identifier (e.g. "2026-slug")
    title TEXT NOT NULL,
    slug TEXT UNIQUE,
    summary TEXT,
    background TEXT,
    solution TEXT,
    year INTEGER NOT NULL,
    program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
    program_name TEXT,
    study_program TEXT,
    discipline TEXT,
    industry TEXT,
    industry_partner TEXT,
    academic_supervisor TEXT,
    group_name TEXT,
    team_members TEXT[] DEFAULT '{}'::TEXT[],
    poster_url TEXT,
    poster_pdf_url TEXT,
    poster_text_public TEXT,
    accessibility_text_public TEXT,
    snapshots TEXT[] DEFAULT '{}'::TEXT[],
    video_url TEXT,
    demo_url TEXT,
    repository_url TEXT,
    external_links JSONB DEFAULT '[]'::JSONB,
    citations TEXT[] DEFAULT '{}'::TEXT[],
    layout_config JSONB DEFAULT '{}'::JSONB,
    status TEXT NOT NULL DEFAULT 'draft' CONSTRAINT check_project_status CHECK (status IN ('draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'published', 'archived', 'deleted')),
    import_batch_id UUID REFERENCES import_batches(id) ON DELETE SET NULL,
    source_folder TEXT,
    internal_staff_notes TEXT,
    private_review_comments TEXT,
    package_validation JSONB,
    validation_flags_cache JSONB,
    validation_errors TEXT[] DEFAULT '{}'::TEXT[],
    validation_warnings TEXT[] DEFAULT '{}'::TEXT[],
    pending_removal_from_public BOOLEAN DEFAULT false,
    public_removal_completed_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    archived_from_status TEXT,
    archive_reason TEXT,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Project-Discipline mapping table (for many-to-many relationship)
CREATE TABLE IF NOT EXISTS project_disciplines (
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    discipline_id UUID REFERENCES disciplines(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, discipline_id)
);

-- Project-Industry Category mapping table (for many-to-many relationship)
CREATE TABLE IF NOT EXISTS project_industry_categories (
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    industry_category_id UUID REFERENCES industry_categories(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, industry_category_id)
);

-- Media Assets table
CREATE TABLE IF NOT EXISTS media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    storage_bucket TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    public_url TEXT,
    mime_type TEXT,
    file_size_bytes BIGINT,
    is_public_approved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Validation Flags table (Rule-level validation records)
CREATE TABLE IF NOT EXISTS validation_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    severity TEXT NOT NULL CONSTRAINT check_flag_severity CHECK (severity IN ('error', 'warning', 'info')),
    rule_code TEXT NOT NULL,
    message TEXT NOT NULL,
    field_name TEXT,
    resolved BOOLEAN DEFAULT false,
    resolved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Approval/Audit Records table
CREATE TABLE IF NOT EXISTS approval_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    action_taken TEXT NOT NULL CONSTRAINT check_audit_action CHECK (action_taken IN ('request_changes', 'approve', 'publish', 'archive', 'unpublish', 'restore', 'soft_delete', 'update_metadata')),
    from_status TEXT,
    to_status TEXT,
    comments TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Published Snapshots table
CREATE TABLE IF NOT EXISTS published_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feed_file_name TEXT NOT NULL,
    storage_bucket TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    public_url TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    feed_hash TEXT NOT NULL,
    created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    rollback_of_snapshot_id UUID REFERENCES published_snapshots(id) ON DELETE SET NULL
);

-- Create Indexes
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_year ON projects(year);
CREATE INDEX IF NOT EXISTS idx_projects_public_id ON projects(public_id);
CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_project_id ON media_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_validation_flags_project_id ON validation_flags(project_id);
CREATE INDEX IF NOT EXISTS idx_approval_records_project_id ON approval_records(project_id);
CREATE INDEX IF NOT EXISTS idx_published_snapshots_created_at ON published_snapshots(created_at);

-- Trigger to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-run safety for trigger creation
DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;

CREATE TRIGGER update_projects_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
