import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

describe('Migration 0014 Participant Preview Confirmations Security Contract Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');
  const priorMigrationFile = '20260810180000_participant_preview_links.sql';
  const migrationFile = '20260811090000_participant_preview_confirmations.sql';

  function readMigrationNormalized(): string {
    return fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8').replace(/\r\n/g, '\n');
  }

  it('1. Migration 0014 is the fourteenth timestamped migration, immediately after Migration 0013 and immediately before Migration 0015', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBe(18);
    expect(sqlFiles[12]).toBe(priorMigrationFile);
    expect(sqlFiles[13]).toBe(migrationFile);
    expect(sqlFiles[14]).toBe('20260811120000_participant_preview_correction_requests.sql');
  });

  it('2. Migration 0013 remains byte-for-byte unmodified against origin/main (this migration never edits it)', () => {
    const filePath = path.join(migrationsDir, priorMigrationFile);
    expect(fs.existsSync(filePath)).toBe(true);
    const localContent = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    const localHash = crypto.createHash('sha256').update(localContent, 'utf8').digest('hex');

    const mainContent = execSync(
      `git show origin/main:infra/supabase/migrations/${priorMigrationFile}`,
      { cwd: repoRoot, encoding: 'utf8' }
    ).replace(/\r\n/g, '\n');
    const mainHash = crypto.createHash('sha256').update(mainContent, 'utf8').digest('hex');

    expect(localHash).toBe(mainHash);
  });

  it('3. participant_preview_confirmations table: one confirmation per preview, RLS, and no anon/authenticated/PUBLIC access', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.participant_preview_confirmations');
    // Exactly one confirmation per exact preview version, enforced at the DB level.
    expect(content).toContain('participant_preview_id UUID NOT NULL UNIQUE');
    expect(content).toContain('REFERENCES public.participant_previews(id) ON DELETE CASCADE');
    expect(content).toContain('confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()');

    // No raw token, IP address, user agent, or invented participant identity is ever persisted.
    expect(content).not.toMatch(/\braw_token\b/);
    expect(content).not.toMatch(/\bplain_token\b/);
    expect(content).not.toMatch(/ip_address/i);
    expect(content).not.toMatch(/user_agent/i);

    expect(content).toContain('ALTER TABLE public.participant_preview_confirmations ENABLE ROW LEVEL SECURITY');
    expect(content).toContain(
      'REVOKE ALL ON public.participant_preview_confirmations FROM PUBLIC, anon, authenticated;'
    );
    expect(content).toContain('GRANT ALL ON public.participant_preview_confirmations TO service_role;');
  });

  it('4. confirm_participant_preview is service-role-only, token-hash-only, and never accepts browser-supplied authority', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.confirm_participant_preview(');
    expect(content).toContain('p_token_hash text');

    // Never accepts a preview id, project id, confirmation timestamp, or actor identity as input —
    // the function signature carries only the token hash.
    expect(content).not.toContain('p_participant_preview_id');
    expect(content).not.toContain('p_project_id');
    expect(content).not.toContain('p_confirmed_at');
    expect(content).not.toContain('p_admin_id');
    expect(content).not.toContain('p_token text');
    expect(content).not.toContain('p_raw_token');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");

    // Row-level FOR UPDATE lock on the resolved preview row is the concurrency/ordering
    // authority against revoke_participant_preview, not React state.
    expect(content).toContain('FOR UPDATE');

    // Eligibility collapses to the identical generic resultCode as resolve_participant_preview
    // for every ineligible condition (malformed, unknown, expired, revoked) — never distinguishable.
    const notFoundMatches = content.match(/'resultCode', 'NOT_FOUND'/g) || [];
    expect(notFoundMatches.length).toBeGreaterThanOrEqual(3);
    expect(content).toContain("v_row.status <> 'active'");
    expect(content).toContain('v_row.revoked_at IS NOT NULL');
    expect(content).toContain('v_row.expires_at <= pg_catalog.now()');

    // Idempotent under concurrent first-time submissions and repeat submissions alike.
    expect(content).toContain('ON CONFLICT (participant_preview_id) DO NOTHING');

    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM PUBLIC;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM anon;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM authenticated;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.confirm_participant_preview(text) TO service_role;'
    );
  });

  it('5. Migration performs no destructive SQL, no dynamic SQL, no auth.users mutations, no workflow-status change, and no publication/public-media operation', () => {
    const content = readMigrationNormalized();

    expect(content).not.toMatch(/DROP\s+TABLE/i);
    expect(content).not.toMatch(/TRUNCATE/i);
    expect(content).not.toMatch(/DELETE\s+FROM/i);
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/); // no dynamic SQL
    expect(content).not.toContain('auth.users');
    expect(content).not.toContain('supabase_admin');
    expect(content).not.toContain('project-public-assets');
    expect(content).not.toMatch(/publish/i);

    // Never mutates the mutable projects row, its workflow status, participant_previews, or
    // media_assets — a confirmation is purely an INSERT of its own audit row, keyed off a
    // read-only resolution of the exact preview.
    expect(content).not.toMatch(/UPDATE\s+public\.projects/i);
    expect(content).not.toMatch(/UPDATE\s+public\.participant_previews/i);
    expect(content).not.toMatch(/UPDATE\s+public\.media_assets/i);
    expect(content).not.toContain('approval_records');
  });
});
