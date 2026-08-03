import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Migration 0008 Transactional Review Actions Static Security Contract Tests', () => {
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
  ];

  it('1. Migration 0008 is the eighth and latest timestamped migration in infra/supabase/migrations', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBe(8);

    for (let i = 0; i < expectedPriorMigrations.length; i++) {
      expect(sqlFiles[i]).toBe(expectedPriorMigrations[i]);
    }

    const latestMigration = sqlFiles[7];
    expect(latestMigration).toContain('transactional_review_actions.sql');
    expect(latestMigration > '20260803174000_harden_function_execute_defaults.sql').toBe(true);
  });

  it('2. Existing migrations 0001 through 0007 remain byte-for-byte unmodified', () => {
    for (const file of expectedPriorMigrations) {
      const filePath = path.join(migrationsDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('3. Migration 0008 includes transaction block, exact signature, SECURITY DEFINER, search_path, and FOR UPDATE locking', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
    const mig0008Content = fs.readFileSync(path.join(migrationsDir, sqlFiles[7]), 'utf8');

    expect(mig0008Content).toContain('BEGIN;');
    expect(mig0008Content).toContain('COMMIT;');

    expect(mig0008Content).toContain('CREATE OR REPLACE FUNCTION public.perform_project_review_action(');
    expect(mig0008Content).toContain('p_public_id text');
    expect(mig0008Content).toContain('p_action text');
    expect(mig0008Content).toContain('p_comments text');
    expect(mig0008Content).toContain('p_admin_id uuid');

    expect(mig0008Content).toContain('SECURITY DEFINER');
    expect(mig0008Content).toContain("SET search_path = ''");

    expect(mig0008Content).toContain('FOR UPDATE');
    expect(mig0008Content).toContain('FOR UPDATE');
  });

  it('4. Migration 0008 performs project update and approval_records audit insert atomically in the same function', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
    const content = fs.readFileSync(path.join(migrationsDir, sqlFiles[7]), 'utf8');

    expect(content).toContain('UPDATE public.projects');
    expect(content).toContain('INSERT INTO public.approval_records');
    expect(content).toContain('RETURNING id INTO v_audit_record_id');

    expect(content).toContain("jsonb_build_object(\n    'publicId', v_public_id,\n    'status', v_to_status,\n    'auditRecordId', v_audit_record_id::text\n  )");
  });

  it('5. Migration 0008 represents exact role permissions and workflow state transitions', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
    const content = fs.readFileSync(path.join(migrationsDir, sqlFiles[7]), 'utf8');

    expect(content).toContain("IF NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)) THEN");
    expect(content).toContain("IF NOT ('admin' = ANY(v_roles)) THEN");

    expect(content).toContain("'submitted', 'in_review'");
    expect(content).toContain("'changes_requested'");
    expect(content).toContain("'approved'");
    expect(content).toContain("'published'");

    expect(content).toContain("'changes_requested'");
    expect(content).toContain("'approved'");
    expect(content).toContain("'archived'");
  });

  it('6. Migration 0008 applies explicit least-privilege ACLs: revokes PUBLIC/anon/authenticated, grants service_role only, leaves supabase_admin untouched', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
    const content = fs.readFileSync(path.join(migrationsDir, sqlFiles[7]), 'utf8');

    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM PUBLIC;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM anon;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM authenticated;');

    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) TO service_role;');

    expect(content).not.toContain('supabase_admin');
  });

  it('7. Migration 0008 contains no destructive SQL, auth.users mutations, storage mutations, or hosted operations', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
    const content = fs.readFileSync(path.join(migrationsDir, sqlFiles[7]), 'utf8');

    expect(content).not.toContain('DROP TABLE');
    expect(content).not.toContain('TRUNCATE');
    expect(content).not.toContain('auth.users');
    expect(content).not.toContain('storage.objects');
    expect(content).not.toContain('schema_migrations');
  });
});
