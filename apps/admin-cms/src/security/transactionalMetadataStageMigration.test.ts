import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

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

    expect(sqlFiles.length).toBe(19);

    for (let i = 0; i < expectedPriorMigrations.length; i++) {
      expect(sqlFiles[i]).toBe(expectedPriorMigrations[i]);
    }

    expect(sqlFiles[9]).toBe('20260810090000_atomic_browser_import_metadata_stage.sql');
  });

  it('2. Existing migrations 0001 through 0009 remain byte-for-byte unmodified against origin/main', () => {
    for (const file of expectedPriorMigrations) {
      const filePath = path.join(migrationsDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
      const localContent = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
      const localHash = crypto.createHash('sha256').update(localContent, 'utf8').digest('hex');

      // Compare with git content on origin/main
      const mainContent = execSync(
        `git show origin/main:infra/supabase/migrations/${file}`,
        { cwd: repoRoot, encoding: 'utf8' }
      ).replace(/\r\n/g, '\n');
      const mainHash = crypto.createHash('sha256').update(mainContent, 'utf8').digest('hex');

      expect(localHash).toBe(mainHash);
    }
  });

  it('3. Migration 0010 contains exact security hardening, bounds, mode restriction, and rollback contract', () => {
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

    expect(content).toContain('status IN (\'pending\', \'processing\', \'metadata_staged\', \'completed\', \'failed\')');
    expect(content).toContain('intent_hash TEXT NOT NULL UNIQUE');
    expect(content).toContain('batch_id UUID NOT NULL UNIQUE REFERENCES public.import_batches(id)');

    expect(content).toContain('v_mode NOT IN (\'single\', \'batch\')');
    expect(content).not.toContain('\'manual\'');
    expect(content).not.toContain('\'unknown\'');

    expect(content).toContain('v_pkg_count = 0 OR v_pkg_count > 25');

    // Revokes & Grants
    expect(content).toContain('ALTER TABLE public.browser_import_commits ENABLE ROW LEVEL SECURITY;');
    expect(content).toContain('GRANT ALL ON public.browser_import_commits TO service_role;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM PUBLIC;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM anon;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM authenticated;');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) TO service_role;');

    // Dynamic SQL and prohibited tables
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/);
    expect(content).not.toContain('media_assets');
    expect(content).not.toContain('storage.objects');
    expect(content).not.toContain('approval_records');

    // Confirm post-mutation section contains zero controlled RETURN statements
    const firstInsertIndex = content.indexOf('INSERT INTO public.import_batches');
    expect(firstInsertIndex).toBeGreaterThan(0);
    const postMutationSection = content.substring(firstInsertIndex);
    expect(postMutationSection).not.toContain('RETURN pg_catalog.jsonb_build_object(\'resultCode\'');
  });
});
