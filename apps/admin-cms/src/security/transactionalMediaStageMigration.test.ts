import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

describe('Migration 0011 Atomic Browser Import Media Stage Security Contract Tests', () => {
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
  ];

  it('1. Migration 0011 is the eleventh timestamped migration in infra/supabase/migrations', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBe(15);

    for (let i = 0; i < expectedPriorMigrations.length; i++) {
      expect(sqlFiles[i]).toBe(expectedPriorMigrations[i]);
    }

    expect(sqlFiles[10]).toBe('20260810120000_atomic_browser_import_media_stage.sql');
  });

  it('2. Existing migrations 0001 through 0010 remain byte-for-byte unmodified against origin/main', () => {
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

  it('3. Migration 0011 contains exact security hardening, bounds, and atomic finalize contract', () => {
    const filePath = path.join(migrationsDir, '20260810120000_atomic_browser_import_media_stage.sql');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.finalize_browser_import_media_stage(');
    expect(content).toContain('p_batch_id uuid');
    expect(content).toContain('p_media_intent_hash text');
    expect(content).toContain('p_metadata_intent_hash text');
    expect(content).toContain('p_completed_by_id uuid');
    expect(content).toContain('p_assets jsonb');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");

    expect(content).toContain('pg_advisory_xact_lock');

    // Idempotency ledger
    expect(content).toContain('media_intent_hash TEXT NOT NULL');
    expect(content).toContain('batch_id UUID NOT NULL UNIQUE REFERENCES public.import_batches(id)');

    // Uniqueness invariants for retry/idempotency safety
    expect(content).toContain('media_assets_project_asset_type_unique');
    expect(content).toContain('media_assets_bucket_path_unique');
    expect(content).toContain('UNIQUE (project_id, asset_type)');
    expect(content).toContain('UNIQUE (storage_bucket, storage_path)');

    // Batch state guard: only metadata_staged may transition to completed
    expect(content).toContain("v_batch.status <> 'metadata_staged'");
    expect(content).toContain("SET status = 'completed'");

    // Cross-batch protection: project must belong to the batch being finalized
    expect(content).toContain('p.import_batch_id = p_batch_id');

    // Convergence guard against silently-wrong conflicting rows
    expect(content).toContain('ON CONFLICT (project_id, asset_type) DO NOTHING');
    expect(content).toContain('MEDIA_ASSET_CONFLICT');

    // Asset count bound (25 packages * 3 files)
    expect(content).toContain('v_asset_count = 0 OR v_asset_count > 75');

    // Never touches projects.status: projects must remain draft
    const functionStart = content.indexOf('CREATE OR REPLACE FUNCTION public.finalize_browser_import_media_stage');
    const functionBody = content.substring(functionStart);
    expect(functionBody).not.toMatch(/UPDATE\s+public\.projects/i);

    // Revokes & Grants
    expect(content).toContain('ALTER TABLE public.browser_import_media_commits ENABLE ROW LEVEL SECURITY;');
    expect(content).toContain('GRANT ALL ON public.browser_import_media_commits TO service_role;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM PUBLIC;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM anon;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) FROM authenticated;');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb) TO service_role;');

    // Dynamic SQL prohibited
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/);
  });
});
