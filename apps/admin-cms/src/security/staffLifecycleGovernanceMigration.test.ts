import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const filename = '20260909120000_staff_lifecycle_readiness.sql';
const migrationPath = path.resolve(
  __dirname,
  '../../../../infra/supabase/migrations',
  filename,
);
const sql = fs.readFileSync(migrationPath, 'utf8');
const localVerifier = fs.readFileSync(
  path.resolve(__dirname, '../scripts/verifyLocalSupabase.ts'),
  'utf8',
);

describe(filename, () => {
  it('adds authoritative lifecycle state without deleting staff or history', () => {
    expect(sql).toContain("ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'active'");
    expect(sql).toContain('ADD COLUMN lifecycle_version bigint NOT NULL DEFAULT 1');
    expect(sql).toContain('ON DELETE SET NULL');
    expect(sql).not.toMatch(/DELETE FROM public\.admin_users/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it('atomically replaces roles and records every real transition', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.manage_staff_lifecycle');
    expect(sql).toContain('DELETE FROM public.user_roles WHERE user_id = v_target.id;');
    expect(sql).toContain('INSERT INTO public.user_roles(user_id, role)');
    expect(sql).toContain('INSERT INTO public.staff_lifecycle_events');
    expect(sql).toContain("p_action NOT IN ('replace_roles', 'deactivate', 'reactivate')");
  });

  it('serializes last-admin protection and rejects self/stale updates', () => {
    expect(sql).toContain("pg_catalog.hashtextextended('capstone.staff_lifecycle_admin_invariant', 0)");
    expect(sql).toContain("'SELF_MODIFICATION_DENIED'");
    expect(sql).toContain("'LAST_ADMIN_PROTECTED'");
    expect(sql).toContain("'STALE_VERSION'");
    expect(sql).toContain('AND staff.auth_user_id IS NOT NULL');
    expect(sql.match(/OR v_actor\.auth_user_id IS NULL/g)).toHaveLength(2);
  });

  it('keeps provider reconciliation token-fenced, expiring and safely retryable', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.claim_staff_provider_reconciliation');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.complete_staff_provider_reconciliation');
    expect(sql).toContain('provider_claim_token_hash');
    expect(sql).toContain("pg_catalog.now() + interval '2 minutes'");
    expect(sql).toContain("provider_status IN ('pending', 'failed')");
  });

  it('revokes retained authenticated-token catalog reads through durable lifecycle state', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.staff_session_is_active()');
    expect(sql).toContain("staff.lifecycle_status = 'active'");
    expect(sql).toContain('staff.auth_user_id = (SELECT auth.uid())');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.staff_session_is_active() TO authenticated;');
    for (const table of ['programs', 'disciplines', 'industry_categories']) {
      expect(sql).toContain(`CREATE POLICY select_${table}_authenticated ON public.${table}`);
    }
    expect(sql.match(/USING \(\(SELECT public\.staff_session_is_active\(\)\)\);/g)).toHaveLength(3);
    expect(localVerifier).toContain(
      "!== 'select staff_session_is_active() as staff_session_is_active'",
    );
    expect(localVerifier).not.toContain("normalizePolicyExpr(foundPol.qual) !== 'true'");
  });

  it('installs one immutable service-only readiness sentinel with the exact capability set', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()');
    expect(sql).toContain('IMMUTABLE');
    expect(sql).toContain('PARALLEL SAFE');
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain(
      '20260909120000_staff_lifecycle_readiness|active_staff_catalog_rls_v1|staff_lifecycle_v1',
    );
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()');
    expect(sql).toContain('TO service_role;');
  });

  it('uses restrictive RLS and service-role-only RPC execution', () => {
    expect(sql).toContain('ALTER TABLE public.staff_lifecycle_events FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('AS RESTRICTIVE');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql.match(/TO service_role;/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|ALL).*staff_lifecycle_events/i);
  });
});
