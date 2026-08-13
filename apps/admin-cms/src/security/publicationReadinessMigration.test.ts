import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

describe('Migration 0017 Publication Readiness Gate Security Contract Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');
  const priorMigrationFile = '20260811130000_participant_preview_correction_resolution.sql';
  const migrationFile = '20260811150000_publication_readiness_gate.sql';

  function readMigrationNormalized(): string {
    return fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8').replace(/\r\n/g, '\n');
  }

  it('1. Migration 0017 is exactly the seventeenth timestamped migration, immediately after Migration 0016', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles).toContain(migrationFile);
    expect(sqlFiles[15]).toBe(priorMigrationFile);
    expect(sqlFiles[16]).toBe(migrationFile);
  });

  it('2. Migrations 0001 through 0016 remain byte-for-byte unmodified against origin/main', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles[16]).toBe(migrationFile);
    const priorMigrationFiles = sqlFiles.slice(0, 16);
    expect(priorMigrationFiles.length).toBe(16);

    for (const file of priorMigrationFiles) {
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

  it('3. get_project_publication_readiness RPC signature, SECURITY DEFINER, search_path, and grants', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.get_project_publication_readiness(');
    expect(content).toContain('p_public_id text');
    expect(content).toContain('p_admin_id uuid');
    expect(content).toContain('p_private_bucket text');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");

    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM PUBLIC;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM anon;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM authenticated;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) TO service_role;'
    );
  });

  it('4. get_project_publication_readiness enforces administrative role authority, snapshot matching, and zero side-effects', () => {
    const content = readMigrationNormalized();

    // Read-only readiness uses existing review authority.
    expect(content).toContain("('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles))");
    expect(content).not.toContain("('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles))");

    // Unresolved lifecycle state remains distinct from contradictory responses
    // attached to the exact confirmed active preview.
    expect(content).toMatch(/r\.status IN \('open', 'in_progress'\)[\s\S]*?'CORRECTION_UNRESOLVED'/);
    expect(content).toMatch(/JOIN public\.participant_preview_confirmations c ON c\.participant_preview_id = pp\.id[\s\S]*?pp\.status = 'active'[\s\S]*?'READINESS_UNAVAILABLE'/);
    expect(content).toMatch(/r\.status = 'resolved'[\s\S]*?r\.replacement_preview_id = v_active_preview\.id/);

    // Readiness checks
    expect(content).toContain("'READY'");
    expect(content).toContain("'PROJECT_NOT_FOUND'");
    expect(content).toContain("'INVALID_PROJECT_STATE'");
    expect(content).toContain("'NO_ACTIVE_PREVIEW'");
    expect(content).toContain("'PREVIEW_NOT_CONFIRMED'");
    expect(content).toContain("'CORRECTION_UNRESOLVED'");
    expect(content).toContain("'CORRECTED_PREVIEW_AWAITING_CONFIRMATION'");
    expect(content).toContain("'PROJECT_SNAPSHOT_STALE'");
    expect(content).toContain("'MEDIA_SNAPSHOT_STALE'");

    // Canonical order-independent media comparison
    expect(content).toContain("ORDER BY (elem->>'mediaAssetId')");

    // Zero publication side-effects assertions
    expect(content).not.toContain("UPDATE public.projects SET status = 'published'");
    expect(content).not.toContain('INSERT INTO public.published_snapshots');
    expect(content).not.toContain('public_feeds');
  });
});
