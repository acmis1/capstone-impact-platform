import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

describe('Migration 0013 Participant Preview Links Security Contract Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');
  const migrationFile = '20260810180000_participant_preview_links.sql';

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
    '20260810150000_atomic_import_batch_review_submit.sql',
  ];

  const confirmationsMigrationFile = '20260811090000_participant_preview_confirmations.sql';

  function readMigrationNormalized(): string {
    return fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8').replace(/\r\n/g, '\n');
  }

  it('1. Migration 0013 is the thirteenth and Migration 0014 is the fourteenth timestamped migration in infra/supabase/migrations', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBe(14);

    for (let i = 0; i < expectedPriorMigrations.length; i++) {
      expect(sqlFiles[i]).toBe(expectedPriorMigrations[i]);
    }

    expect(sqlFiles[12]).toBe(migrationFile);
    expect(sqlFiles[13]).toBe(confirmationsMigrationFile);
  });

  it('2. Existing migrations 0001 through 0013 remain byte-for-byte unmodified against origin/main', () => {
    for (const file of [...expectedPriorMigrations, migrationFile]) {
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

  it('3. Table, RLS, and single-active-preview invariant are present', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.participant_previews');
    expect(content).toContain("token_hash TEXT NOT NULL UNIQUE");
    expect(content).toContain("token_hash ~ '^[0-9a-f]{64}$'");

    // Raw tokens are never a column on this table — only the hash.
    expect(content).not.toMatch(/\braw_token\b/);
    expect(content).not.toMatch(/\bplain_token\b/);

    expect(content).toContain('ALTER TABLE public.participant_previews ENABLE ROW LEVEL SECURITY');
    expect(content).toContain('REVOKE ALL ON public.participant_previews FROM PUBLIC, anon, authenticated;');
    expect(content).toContain('GRANT ALL ON public.participant_previews TO service_role;');

    // DB-level single-active-preview invariant, not merely an application-layer check.
    expect(content).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_previews_one_active_per_project\n  ON public.participant_previews(project_id) WHERE status = 'active';"
    );
  });

  it('4. generate_participant_preview enforces eligibility, authorization, locking, and never accepts a client-generated token', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.generate_participant_preview(');
    expect(content).toContain('p_token_hash text');
    // The RPC signature accepts only a pre-computed hash, never a raw token parameter.
    expect(content).not.toContain('p_token text');
    expect(content).not.toContain('p_raw_token');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");
    expect(content).toContain('pg_advisory_xact_lock');
    expect(content).toContain('FOR UPDATE');

    // Eligibility: approved projects only.
    expect(content).toContain("IF v_status <> 'approved' THEN");

    // Authorization reuses the existing projects.review permission (admin or reviewer).
    expect(content).toContain("'admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)");

    // Single-active-preview: app-layer pre-check plus DB-level unique_violation defense-in-depth.
    expect(content).toContain("WHERE project_id = v_project_id\n     AND status = 'active';");
    expect(content).toContain('ACTIVE_PREVIEW_EXISTS');
    expect(content).toContain('WHEN unique_violation THEN');

    // Snapshot excludes internal-only fields (checked as actual column references, not prose).
    expect(content).not.toContain('p.internal_staff_notes');
    expect(content).not.toContain('p.private_review_comments');
    expect(content).not.toContain('p.validation_flags_cache');

    // Media snapshot is scoped strictly to the target project's own rows AND to media that is
    // authoritatively still private draft media (server-configured bucket, not yet
    // public-approved, no public URL) — never a browser-supplied bucket value.
    expect(content).toContain(
      'FROM public.media_assets ma\n   WHERE ma.project_id = v_project_id\n     AND ma.storage_bucket = v_private_bucket\n     AND ma.is_public_approved = false\n     AND ma.public_url IS NULL;'
    );
    expect(content).toContain('p_private_bucket text');
    expect(content).toContain("IF p_private_bucket IS NULL OR pg_catalog.btrim(p_private_bucket) = '' THEN");

    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM PUBLIC;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM anon;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM authenticated;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) TO service_role;'
    );
  });

  it('5. revoke_participant_preview and resolve_participant_preview are locked to service_role only', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.revoke_participant_preview(');
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.revoke_participant_preview(text, uuid) FROM PUBLIC;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.revoke_participant_preview(text, uuid) TO service_role;'
    );

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.resolve_participant_preview(');
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.resolve_participant_preview(text) FROM PUBLIC;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.resolve_participant_preview(text) FROM anon;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.resolve_participant_preview(text) FROM authenticated;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_participant_preview(text) TO service_role;'
    );

    // Every failure branch of resolution collapses to the same generic resultCode.
    const notFoundMatches = content.match(/'resultCode', 'NOT_FOUND'/g) || [];
    expect(notFoundMatches.length).toBeGreaterThanOrEqual(3);
  });

  it('6. Migration contains no destructive SQL, no dynamic SQL, no auth.users mutations, and no public/hosted operations', () => {
    const content = readMigrationNormalized();

    expect(content).not.toMatch(/DROP\s+TABLE/i);
    expect(content).not.toMatch(/TRUNCATE/i);
    expect(content).not.toMatch(/DELETE\s+FROM/i);
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/); // no dynamic SQL
    expect(content).not.toContain('auth.users');
    expect(content).not.toContain('supabase_admin');
    expect(content).not.toContain('project-public-assets');
    // This migration only ever reads is_public_approved (to scope the private media snapshot);
    // it must never write/mutate media_assets at all.
    expect(content).not.toMatch(/UPDATE\s+public\.media_assets/i);
    expect(content).not.toMatch(/publish/i);
  });
});
