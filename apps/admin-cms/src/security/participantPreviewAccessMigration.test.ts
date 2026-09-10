import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_REPOSITORY_MIGRATION_COUNT,
  EXPECTED_REPOSITORY_MIGRATIONS,
  REQUIRED_RPC_NAMES,
  REQUIRED_RPC_SIGNATURES,
} from '../deployment/hostedDeploymentReadiness';

const root = path.resolve(__dirname, '../../../..');
const filename = '20260910120100_participant_preview_access_observations.sql';
const sql = fs.readFileSync(path.join(root, 'infra/supabase/migrations', filename), 'utf8');
const ddl = sql.replace(/--[^\n]*/g, '');
const runtimeVerifier = fs.readFileSync(
  path.join(root, 'apps/admin-cms/src/scripts/verifyParticipantPreviewAccessRuntime.ts'),
  'utf8',
);

describe('participant preview response-observation migration', () => {
  it('remains forward-only migration 0055 in the exact repository inventory', () => {
    const files = fs.readdirSync(path.join(root, 'infra/supabase/migrations'))
      .filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_REPOSITORY_MIGRATIONS]);
    expect(files).toHaveLength(56);
    expect(EXPECTED_REPOSITORY_MIGRATION_COUNT).toBe(56);
    expect(files.at(-2)).toBe(filename);
    expect(files.at(-1)).toBe('20260910120200_assistive_worker_production_identity.sql');
    expect(REQUIRED_RPC_NAMES).toContain('record_participant_preview_response_prepared');
    expect(REQUIRED_RPC_SIGNATURES).toHaveLength(92);
    expect(() => execFileSync('git', [
      'diff', '--exit-code', 'HEAD', '--',
      ...files.slice(0, -1).map((file) => `infra/supabase/migrations/${file}`),
    ], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });

  it('stores one bounded timestamp per exact preview with lifecycle retention and no backfill', () => {
    expect(sql).toMatch(/participant_preview_id uuid PRIMARY KEY[\s\S]*REFERENCES public\.participant_previews\(id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/first_response_prepared_at timestamptz NOT NULL DEFAULT pg_catalog\.clock_timestamp\(\)/i);
    expect(sql).not.toMatch(/INSERT INTO public\.participant_preview_access_observations\s*\([^)]*\)\s*SELECT/i);
    expect(ddl).not.toMatch(/raw.?token|ip.?address|user.?agent|provider.?text|email/i);
  });

  it('uses an exact capability row lock and cannot create confirmation, approval or workflow authority', () => {
    expect(sql).toMatch(/WHERE id = p_preview_id AND token_hash = p_token_hash FOR SHARE/i);
    expect(sql).toMatch(/status <> 'active'[\s\S]*revoked_at IS NOT NULL[\s\S]*expires_at <= v_observed_at/i);
    expect(sql).toMatch(/ON CONFLICT \(participant_preview_id\) DO NOTHING/i);
    expect(sql).not.toMatch(/INSERT INTO public\.(participant_preview_confirmations|approval_records)|UPDATE public\.projects/i);
  });

  it('keeps the table SELECT-only and the definer RPC executable only by service_role', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.participant_preview_access_observations[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.participant_preview_access_observations TO service_role/i);
    expect(sql).toMatch(/SECURITY DEFINER[\s\S]*SET search_path = ''/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.record_participant_preview_response_prepared\(uuid,text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_participant_preview_response_prepared\(uuid,text\)[\s\S]*TO service_role/i);
  });

  it('checks the PUBLIC function ACL without treating PUBLIC as a database role', () => {
    expect(runtimeVerifier).not.toMatch(/has_function_privilege\(['"]PUBLIC['"]/i);
    expect(runtimeVerifier).toMatch(/acl\.grantee\s*=\s*0[\s\S]*acl\.privilege_type\s*=\s*'EXECUTE'/i);
  });
});
