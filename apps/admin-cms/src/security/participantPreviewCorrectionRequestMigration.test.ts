import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

describe('Migration 0015 Participant Preview Correction Requests Security Contract Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');
  const priorLinksMigrationFile = '20260810180000_participant_preview_links.sql';
  const priorConfirmationsMigrationFile = '20260811090000_participant_preview_confirmations.sql';
  const migrationFile = '20260811120000_participant_preview_correction_requests.sql';

  function readMigrationNormalized(): string {
    return fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8').replace(/\r\n/g, '\n');
  }

  it('1. Migration 0015 is exactly the fifteenth timestamped migration, immediately after Migration 0014', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBe(19);
    expect(sqlFiles[12]).toBe(priorLinksMigrationFile);
    expect(sqlFiles[13]).toBe(priorConfirmationsMigrationFile);
    expect(sqlFiles[14]).toBe(migrationFile);
  });

  it('2. Migrations 0001 through 0014 remain byte-for-byte unmodified against origin/main (this migration never edits them)', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles[14]).toBe(migrationFile);
    const priorMigrationFiles = sqlFiles.slice(0, 14);
    expect(priorMigrationFiles.length).toBe(14);

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

  it('3. participant_preview_correction_requests table: exact-preview FK/uniqueness, comment bound, server-generated requested_at, initial open status, RLS, and no anon/authenticated/PUBLIC access', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.participant_preview_correction_requests');
    // Exactly one correction request per exact preview version, enforced at the DB level.
    expect(content).toContain('participant_preview_id UUID NOT NULL UNIQUE');
    expect(content).toContain('REFERENCES public.participant_previews(id) ON DELETE CASCADE');
    expect(content).toContain('requested_at TIMESTAMPTZ NOT NULL DEFAULT now()');

    // Initial status is 'open' only; admin resolution is explicitly not implemented.
    expect(content).toContain("status TEXT NOT NULL DEFAULT 'open'");
    expect(content).toContain("CHECK (status IN ('open'))");

    // Comment bound: never empty/whitespace-only (full \s whitespace, not just literal spaces),
    // never over 2000 characters.
    expect(content).toContain("pg_catalog.regexp_replace(correction_comment, '^\\s+|\\s+$', '', 'g') <> ''");
    expect(content).toContain('pg_catalog.length(correction_comment) <= 2000');

    // No raw token, IP address, user agent, or invented participant identity is ever persisted.
    expect(content).not.toMatch(/\braw_token\b/);
    expect(content).not.toMatch(/\bplain_token\b/);
    expect(content).not.toMatch(/ip_address/i);
    expect(content).not.toMatch(/user_agent/i);

    expect(content).toContain('ALTER TABLE public.participant_preview_correction_requests ENABLE ROW LEVEL SECURITY');
    expect(content).toContain(
      'REVOKE ALL ON public.participant_preview_correction_requests FROM PUBLIC, anon, authenticated;'
    );
    expect(content).toContain('GRANT ALL ON public.participant_preview_correction_requests TO service_role;');

    // Table itself carries no policies (access is exclusively via SECURITY DEFINER RPC / service
    // role client) — the migration must never contain a CREATE POLICY for this table.
    expect(content).not.toMatch(/CREATE POLICY[^;]*participant_preview_correction_requests/i);
  });

  it('4. request_participant_preview_correction is service-role-only, token-hash-and-comment-only, and never accepts browser-supplied authority', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.request_participant_preview_correction(');
    expect(content).toContain('p_token_hash text');
    expect(content).toContain('p_comment text');

    // Never accepts a preview id, project id, request timestamp, status, or actor identity as
    // input — the function signature carries only the token hash and the comment text.
    expect(content).not.toContain('p_participant_preview_id');
    expect(content).not.toContain('p_project_id');
    expect(content).not.toContain('p_requested_at');
    expect(content).not.toContain('p_status');
    expect(content).not.toContain('p_admin_id');
    expect(content).not.toContain('p_token text');
    expect(content).not.toContain('p_raw_token');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");

    // No dynamic SQL anywhere in this migration.
    expect(content).not.toMatch(/\bEXECUTE\s+['"]/);

    // Row-level FOR UPDATE lock on the resolved preview row is the concurrency/ordering
    // authority shared with confirm_participant_preview and revoke_participant_preview.
    expect(content).toContain('FOR UPDATE');

    // Eligibility collapses to the identical generic resultCode as resolve_participant_preview /
    // confirm_participant_preview for every ineligible token condition.
    expect(content).toContain("v_row.status <> 'active'");
    expect(content).toContain('v_row.revoked_at IS NOT NULL');
    expect(content).toContain('v_row.expires_at <= pg_catalog.now()');

    // Server-side comment normalization/validation independent of the calling Next.js route.
    expect(content).toContain("v_comment := pg_catalog.regexp_replace(COALESCE(p_comment, ''), '^\\s+|\\s+$', '', 'g');");
    expect(content).toContain("'resultCode', 'INVALID_COMMENT'");

    // Mutual exclusion against an existing confirmation.
    expect(content).toContain('FROM public.participant_preview_confirmations c');
    expect(content).toContain("'resultCode', 'ALREADY_CONFIRMED'");

    // Idempotent under concurrent first-time submissions and repeat submissions alike; the
    // original comment/timestamp are never overwritten by a losing/later submission.
    expect(content).toContain('ON CONFLICT (participant_preview_id) DO NOTHING');

    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) FROM PUBLIC;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) FROM anon;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) FROM authenticated;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) TO service_role;'
    );
  });

  it('5. confirm_participant_preview is replaced only in Migration 0015 (never Migration 0014), preserves its existing signature/security posture, and adds the symmetric correction-exists mutual-exclusion check', () => {
    const content = readMigrationNormalized();
    const priorConfirmationsContent = fs
      .readFileSync(path.join(migrationsDir, priorConfirmationsMigrationFile), 'utf8')
      .replace(/\r\n/g, '\n');

    // Migration 0014's own file never itself defines a second CREATE OR REPLACE — the extension
    // lives exclusively in this migration.
    expect((priorConfirmationsContent.match(/CREATE OR REPLACE FUNCTION public\.confirm_participant_preview\(/g) || []).length).toBe(1);

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.confirm_participant_preview(');
    expect(content).toContain('p_token_hash text');
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");
    expect(content).toContain('ON CONFLICT (participant_preview_id) DO NOTHING');

    // Symmetric mutual-exclusion check: a correction request already recorded for this exact
    // preview blocks a new confirmation.
    expect(content).toContain('FROM public.participant_preview_correction_requests r');
    expect(content).toContain("'resultCode', 'CORRECTION_REQUESTED'");

    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM PUBLIC;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM anon;');
    expect(content).toContain('REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM authenticated;');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.confirm_participant_preview(text) TO service_role;');
  });

  it('6. Migration performs no destructive SQL, no dynamic SQL, no auth.users mutations, no publication/public-media operation, and no project-status change', () => {
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
    // media_assets — both RPCs perform, at most, one INSERT of their own audit row, keyed off a
    // read-only resolution of the exact preview.
    expect(content).not.toMatch(/UPDATE\s+public\.projects/i);
    expect(content).not.toMatch(/UPDATE\s+public\.participant_previews/i);
    expect(content).not.toMatch(/UPDATE\s+public\.media_assets/i);
    expect(content).not.toContain('approval_records');
    expect(content).not.toContain('published_snapshots');
  });
});
