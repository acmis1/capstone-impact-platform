import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

describe('Migration 0016 Participant Preview Correction Resolution Security Contract Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const migrationsDir = path.join(repoRoot, 'infra/supabase/migrations');
  const priorLinksMigrationFile = '20260810180000_participant_preview_links.sql';
  const priorConfirmationsMigrationFile = '20260811090000_participant_preview_confirmations.sql';
  const priorCorrectionRequestsMigrationFile = '20260811120000_participant_preview_correction_requests.sql';
  const migrationFile = '20260811130000_participant_preview_correction_resolution.sql';

  function readMigrationNormalized(): string {
    return fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8').replace(/\r\n/g, '\n');
  }

  it('1. Migration 0016 is exactly the sixteenth timestamped migration, immediately after Migration 0015', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles.length).toBe(18);
    expect(sqlFiles[12]).toBe(priorLinksMigrationFile);
    expect(sqlFiles[13]).toBe(priorConfirmationsMigrationFile);
    expect(sqlFiles[14]).toBe(priorCorrectionRequestsMigrationFile);
    expect(sqlFiles[15]).toBe(migrationFile);
  });

  it('2. Migrations 0001 through 0015 remain byte-for-byte unmodified against origin/main', () => {
    const rawFiles = fs.readdirSync(migrationsDir);
    const sqlFiles = rawFiles.filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b));

    expect(sqlFiles[15]).toBe(migrationFile);
    const priorMigrationFiles = sqlFiles.slice(0, 15);
    expect(priorMigrationFiles.length).toBe(15);

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

  it('3. participant_preview_correction_requests table extension & security posture', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');

    expect(content).toContain('ALTER TABLE public.participant_preview_correction_requests');
    expect(content).toContain("ADD CONSTRAINT check_participant_preview_correction_request_status");
    expect(content).toContain("CHECK (status IN ('open', 'in_progress', 'resolved'))");
    expect(content).toContain('ADD COLUMN IF NOT EXISTS resolution_started_at TIMESTAMPTZ');
    expect(content).toContain('ADD COLUMN IF NOT EXISTS resolution_started_by UUID REFERENCES public.admin_users(id) ON DELETE NO ACTION');
    expect(content).toContain('ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ');
    expect(content).toContain('ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES public.admin_users(id) ON DELETE NO ACTION');
    expect(content).toContain('ADD COLUMN IF NOT EXISTS replacement_preview_id UUID REFERENCES public.participant_previews(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED');

    expect(content).not.toContain('resolution_started_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL');
    expect(content).not.toContain('resolved_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL');
    expect(content).not.toContain('replacement_preview_id UUID REFERENCES public.participant_previews(id) ON DELETE SET NULL');
    expect(content).not.toContain('replacement_preview_id UUID REFERENCES public.participant_previews(id) ON DELETE CASCADE');

    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");
  });

  it('4. start_participant_preview_correction_resolution RPC signature, permission checks, and transactional logic', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.start_participant_preview_correction_resolution(');
    expect(content).toContain('p_public_id text');
    expect(content).toContain('p_admin_id uuid');

    // Requires combined projects.edit AND projects.review permissions
    expect(content).toContain("('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles))");
    expect(content).toContain("('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles))");

    // Transition project status from approved to changes_requested and insert audit record
    expect(content).toContain("SET status = 'changes_requested'");
    expect(content).toContain('INSERT INTO public.approval_records');

    // State transitions for correction request to in_progress
    expect(content).toContain("SET status = 'in_progress'");

    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) FROM PUBLIC;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) FROM anon;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) FROM authenticated;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) TO service_role;'
    );
  });

  it('5. generate_participant_preview replacement enforces blocking unresolved corrections and resolving in_progress corrections upon reissue', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.generate_participant_preview(');
    expect(content).toContain('p_is_correction_reissue boolean\n)');
    expect(content).not.toContain('p_is_correction_reissue boolean DEFAULT false');

    // Blocking ordinary preview generation when unresolved correction exists
    expect(content).toContain("'resultCode', 'CORRECTION_RESOLUTION_REQUIRED'");

    // Marking correction as resolved on reissue when status is in_progress and project is approved
    expect(content).toContain("SET status = 'resolved'");

    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM PUBLIC;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM anon;'
    );
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM authenticated;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) TO service_role;'
    );
  });

  it('6. generate_participant_preview legacy 5-arg wrapper exists and delegates with false', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('CREATE OR REPLACE FUNCTION public.generate_participant_preview(');
    expect(content).toContain('p_private_bucket text\n)');
    expect(content).toContain('false\n  );');
    expect(content).toContain(
      'REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM PUBLIC;'
    );
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) TO service_role;'
    );
  });

  it('7. start_participant_preview_correction_resolution declares v_unresolved_count and enforces wrong active preview and ambiguity checks', () => {
    const content = readMigrationNormalized();

    expect(content).toContain('v_unresolved_count integer;');
    expect(content).toContain("'resultCode', 'CONFLICTING_ACTIVE_PREVIEW'");
    expect(content).toContain("'resultCode', 'AMBIGUOUS_CORRECTION_REQUEST'");
  });
});
