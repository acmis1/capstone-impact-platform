import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migrations = path.join(root, 'infra/supabase/migrations');
const migration = '20260811160000_approval_edit_gate.sql';
const content = fs.readFileSync(path.join(migrations, migration), 'utf8');

describe('Migration 0018 approval edit gate static security contract', () => {
  it('is the eighteenth migration and leaves 0001-0017 byte-for-byte identical to origin/main', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toHaveLength(18);
    expect(files[17]).toBe(migration);
    for (const file of files.slice(0, 17)) {
      const migrationPath = `infra/supabase/migrations/${file}`;
      const baseBlob = execFileSync('git', ['rev-parse', `origin/main:${migrationPath}`], { cwd: root, encoding: 'utf8' }).trim();
      const headBlob = execFileSync('git', ['rev-parse', `HEAD:${migrationPath}`], { cwd: root, encoding: 'utf8' }).trim();
      expect(headBlob).toBe(baseBlob);
    }
  });

  it('replaces protected RPCs with locked, service-role-only, forward-only behavior', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.update_project_metadata');
    expect(content).toContain('APPROVAL_REOPEN_REQUIRED');
    expect(content).toContain('PUBLISHED_PROJECT_LOCKED');
    expect(content).toContain('p_expected_updated_at');
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.perform_project_review_action');
    expect(content).toContain("REVIEW_COMMENTS_TOO_LONG");
    expect(content).toContain("pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id))");
    expect(content).toContain('CORRECTION_RESOLUTION_REQUIRED');
    expect(content).toContain('AMBIGUOUS_ACTIVE_PREVIEW');
    expect(content).toContain("status = 'revoked'");
    expect(content).toContain('SECURITY DEFINER SET search_path = \'\'');
    expect(content).toContain('REVOKE ALL ON FUNCTION public.perform_project_review_action');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.perform_project_review_action');
    expect(content).not.toMatch(/public-feeds|duda|email|is_public_approved/i);
  });
});
