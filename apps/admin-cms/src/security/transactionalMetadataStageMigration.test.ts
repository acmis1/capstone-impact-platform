import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Migration 0010 Atomic Browser Import Metadata Stage Security Contract Tests', () => {
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
  ];

  it('1. Migration 0010 is the tenth timestamped migration in infra/supabase/migrations', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBe(10);

    for (let i = 0; i < expectedPriorMigrations.length; i++) {
      expect(sqlFiles[i]).toBe(expectedPriorMigrations[i]);
    }

    expect(sqlFiles[9]).toBe('20260810090000_atomic_browser_import_metadata_stage.sql');
  });

  it('2. Existing migrations 0001 through 0009 remain byte-for-byte unmodified', () => {
    for (const file of expectedPriorMigrations) {
      const filePath = path.join(migrationsDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('3. Migration 0010 contains explicit transaction block, SECURITY DEFINER, search_path, advisory lock, and service_role grant', () => {
    const filePath = path.join(migrationsDir, '20260810090000_atomic_browser_import_metadata_stage.sql');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.stage_browser_import_metadata(');
    expect(content).toContain('p_intent_hash text');
    expect(content).toContain('p_preview_fingerprint text');
    expect(content).toContain('p_canonical_intent jsonb');
    expect(content).toContain('p_mode text');
    expect(content).toContain('p_source_folder text');
    expect(content).toContain('p_imported_by_id uuid');
    expect(content).toContain('p_packages jsonb');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");

    expect(content).toContain('pg_advisory_xact_lock');

    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.stage_browser_import_metadata');
    expect(content).toContain('TO service_role;');
  });
});
