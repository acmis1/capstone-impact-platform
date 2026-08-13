import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

describe('Migration 0012 Atomic Import Batch Review Submit Security Contract Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');

  const expectedPriorMigrations = [
    '20260601035138_staging_schema.sql',
    '20260601035139_staging_rls_policies.sql',
    '20260715102956_admin_auth_identity.sql',
    '20260719003407_explicit_data_api_grants.sql',
    '20260719165118_initial_admin_bootstrap.sql',
    '20260719165119_fix_initial_admin_bootstrap_runtime.sql',
    '20260803174000_harden_function_execute_defaults.sql',
    '20260803180000_transactional_review_actions.sql',
    '20260808170000_transactional_project_metadata_update.sql',
    '20260810090000_atomic_browser_import_metadata_stage.sql',
    '20260810120000_atomic_browser_import_media_stage.sql',
  ];

  it('1. Migration 0012 is the twelfth timestamped migration in infra/supabase/migrations', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBeGreaterThanOrEqual(20);

    for (let i = 0; i < expectedPriorMigrations.length; i++) {
      expect(sqlFiles[i]).toBe(expectedPriorMigrations[i]);
    }

    expect(sqlFiles[11]).toBe('20260810150000_atomic_import_batch_review_submit.sql');
  });

  it('2. Existing migrations 0001 through 0011 remain byte-for-byte unmodified against origin/main', () => {
    for (const file of expectedPriorMigrations) {
      const filePath = path.join(migrationsDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
      const localContent = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
      const localHash = crypto.createHash('sha256').update(localContent, 'utf8').digest('hex');

      const mainContent = execSync(
        `git show origin/main:infra/supabase/migrations/${file}`,
        { cwd: repoRoot, encoding: 'utf8' }
      ).replace(/\r\n/g, '\n');
      const mainHash = crypto.createHash('sha256').update(mainContent, 'utf8').digest('hex');

      expect(localHash).toBe(mainHash);
    }
  });

  it('3. Migration 0012 contains exact security hardening, locking, and atomic contract', () => {
    const filePath = path.join(migrationsDir, '20260810150000_atomic_import_batch_review_submit.sql');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.submit_import_projects_for_review(');
    expect(content).toContain('p_batch_id uuid');
    expect(content).toContain('p_project_public_ids text[]');
    expect(content).toContain('p_admin_id uuid');
    expect(content).toContain('p_comments text');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");

    expect(content).toContain('pg_advisory_xact_lock');
    expect(content).toContain('FOR UPDATE');

    // Authorization: editors (projects.edit) may submit; reviewer-only must not.
    expect(content).toContain("'admin' = ANY(v_roles) OR 'editor' = ANY(v_roles)");
    expect(content).not.toContain("'reviewer' = ANY(v_roles)");

    // Eligible source states and idempotent already-submitted handling
    expect(content).toContain("IN ('draft', 'changes_requested')");
    expect(content).toContain("v_project.status = 'submitted'");

    // Audit vocabulary extension: submission is distinct from approval
    expect(content).toContain("ADD CONSTRAINT check_audit_action");
    expect(content).toContain("'submit_for_review'");
    expect(content).toContain("'approve'");

    // Readiness re-derivation happens before any mutation
    const validationMarkerIndex = content.indexOf('ALL VALIDATION PASSED BEFORE MUTATIONS BEGIN');
    const firstUpdateIndex = content.indexOf('UPDATE public.projects');
    const firstInsertIndex = content.indexOf('INSERT INTO public.approval_records');
    expect(validationMarkerIndex).toBeGreaterThan(-1);
    expect(firstUpdateIndex).toBeGreaterThan(validationMarkerIndex);
    expect(firstInsertIndex).toBeGreaterThan(validationMarkerIndex);

    // Cross-batch protection: project must belong to the batch being submitted
    expect(content).toContain('p.import_batch_id = p_batch_id');

    // Media must remain private: never trusts is_public_approved = true or a populated public_url
    expect(content).toContain('ma.public_url IS NULL AND ma.is_public_approved = false');

    // Never approves/publishes/promotes media as a side effect
    expect(content).not.toContain("'approved'");
    expect(content).not.toContain("'published'");
    expect(content).not.toMatch(/SET\s+is_public_approved\s*=\s*true/i);
    expect(content).not.toMatch(/SET\s+public_url\s*=/i);

    // Revokes & Grants
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM PUBLIC;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM anon;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM authenticated;');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) TO service_role;');

    // Dynamic SQL prohibited
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/);

    expect(content).not.toContain('supabase_admin');
  });

  it('4. Migration 0012 contains no destructive SQL, auth.users mutations, storage mutations, or hosted operations', () => {
    const filePath = path.join(migrationsDir, '20260810150000_atomic_import_batch_review_submit.sql');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('DROP TABLE');
    expect(content).not.toContain('TRUNCATE');
    expect(content).not.toContain('auth.users');
    expect(content).not.toContain('storage.objects');
    expect(content).not.toContain('schema_migrations');
  });
});
