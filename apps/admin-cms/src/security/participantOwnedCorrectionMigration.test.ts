// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_BUCKETS, MIGRATION_MANAGED_BUCKETS } from '../local-development/localSupabaseFixtures';
import { REQUIRED_STORAGE_BUCKETS } from '../deployment/hostedDeploymentReadiness';
import { CANONICAL_STORAGE_BUCKETS } from '../recovery/zeroCostRecoveryContract';

const sql = readFileSync(resolve(__dirname, '../../../../infra/supabase/migrations/20260903130000_participant_owned_corrections.sql'), 'utf8');
const configToml = readFileSync(resolve(__dirname, '../../../../infra/supabase/config.toml'), 'utf8');
describe('participant correction migration authority', () => {
  it('limits retirement to project media and project taxonomy mappings', () => {
    const targets = [...sql.matchAll(/DELETE FROM\s+([\w.]+)/g)].map((match) => match[1]);
    expect(targets).toEqual(['public.project_disciplines', 'public.project_industry_categories', 'public.media_assets']);
    for (const statement of sql.matchAll(/DELETE FROM[^;]+;/g)) {
      expect(statement[0]).toMatch(/project_id=p\.id/);
      expect(statement[0]).toMatch(/to_jsonb\([dim]\)=old_row/);
    }
  });
  it('records recoverable rows before applying metadata or retiring any row', () => {
    const recovery = sql.indexOf('INSERT INTO public.participant_correction_recovery_rows');
    expect(recovery).toBeGreaterThan(sql.indexOf('INSERT INTO public.participant_correction_prior_revisions'));
    expect(recovery).toBeLessThan(sql.indexOf('UPDATE public.projects SET title='));
    expect(recovery).toBeLessThan(sql.indexOf('DELETE FROM'));
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]*UNAVAILABLE/);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });
  it('exposes no mutation authority to participant or ordinary authenticated roles', () => {
    expect(sql).not.toMatch(/GRANT (?:ALL|INSERT|UPDATE|DELETE|EXECUTE)[^;]+ TO (?:PUBLIC|anon|authenticated)/i);
    expect((sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length).toBe(4);
    expect((sql.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length).toBe(6);
  });
  it.each([
    'participant_correction_submissions', 'participant_correction_prior_revisions',
    'participant_correction_recovery_rows', 'participant_correction_events',
  ])('bounds direct grants on %s after removing default ACL privileges', (table) => {
    const statements = sql.replace(/--[^\n]*/g, '').split(';')
      .map((statement) => statement.trim().replace(/\s+/g, ' ').toLowerCase());
    const revokePattern = new RegExp('^revoke all(?: privileges)? on(?: table)? public\\.' + table + ' from (.+)$');
    const grantPattern = new RegExp('^grant (.+) on(?: table)? public\\.' + table + ' to (.+)$');
    const revokes = statements.map((statement) => statement.match(revokePattern)).filter((match) => match !== null);
    const grants = statements.map((statement) => statement.match(grantPattern)).filter((match) => match !== null);
    expect(revokes).toHaveLength(1);
    expect(revokes[0][1].split(',').map((role) => role.trim()).sort())
      .toEqual(['anon', 'authenticated', 'public', 'service_role']);
    expect(grants.map((match) => [match[1], match[2]])).toEqual([['select', 'service_role']]);
    expect(statements.indexOf(revokes[0][0])).toBeLessThan(statements.indexOf(grants[0][0]));
  });
  it('preserves historical snapshot and confirmation evidence and forbids Storage deletion', () => {
    expect(sql).not.toMatch(/(?:DELETE FROM|UPDATE)\s+storage\./i);
    expect(sql).not.toMatch(/UPDATE public\.participant_previews SET[^;]*(?:snapshot|token_hash)/i);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM) public\.participant_preview_confirmations/i);
    expect(sql).not.toMatch(/UPDATE public\.participant_preview_correction_requests SET[^;]*\bcomment\s*=/i);
  });
  it('owns the correction bucket contract that config and fixtures deliberately never provision', () => {
    // The migration is the sole authority for this bucket. Pinning the read-only repository mirror
    // to its bytes lets a verifier assert the bucket without any repository code path being able to
    // create or reconfigure it.
    const insert = /INSERT INTO storage\.buckets\(id,name,public,file_size_limit,allowed_mime_types\)\s*VALUES\('([a-z-]+)','([a-z-]+)',(true|false),(\d+),\s*ARRAY\[([^\]]+)\]\)\s*ON CONFLICT\(id\) DO NOTHING;/.exec(sql);
    expect(insert).not.toBeNull();
    const [, id, name, isPublic, fileSizeLimit, mimeTypes] = insert as RegExpExecArray;
    expect(name).toBe(id);
    expect(MIGRATION_MANAGED_BUCKETS).toEqual([{
      name: id,
      isPublic: isPublic === 'true',
      fileSizeLimit: Number(fileSizeLimit),
      allowedMimeTypes: mimeTypes.split(',').map((value) => value.trim().replace(/^'|'$/g, '')),
    }]);

    // ON CONFLICT DO NOTHING means a pre-created bucket silently wins, so config-managed or
    // fixture-managed creation of this id would hide a broken Migration 0051 instead of exposing
    // it. The bucket still belongs to the four-bucket release/recovery inventory.
    expect(EXPECTED_BUCKETS.map((bucket) => bucket.name)).not.toContain(id);
    expect(configToml).not.toContain(id);
    expect(REQUIRED_STORAGE_BUCKETS).toContain(id);
    expect(CANONICAL_STORAGE_BUCKETS).toContain(id);
  });
});
