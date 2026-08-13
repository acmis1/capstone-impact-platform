import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

const PRIVILEGED_FUNCTIONS = [
  'public.reserve_staff_provisioning(uuid, text, text, text[])',
  'public.bind_staff_provisioning_identity(uuid, uuid)',
  'public.finalize_staff_provisioning(uuid)',
  'public.activate_staff_provisioning(uuid)',
  'public.fail_staff_provisioning(uuid, text, text)',
] as const;

describe('staff identity provisioning migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260813120000_staff_identity_provisioning.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8');
  const squashed = content.replace(/\s+/g, ' ');

  it('is the exact twenty-second append-only migration in the authoritative inventory', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(22);
    expect(files[21]).toBe(filename);
  });

  it('leaves every earlier migration and the bootstrap path untouched', () => {
    // The migration may only create new objects. It must not redefine, drop or re-grant the
    // first-administrator bootstrap function, nor alter any pre-existing identity table.
    expect(content).not.toContain('FUNCTION public.bootstrap_initial_admin');
    expect(content).not.toMatch(/(CREATE OR REPLACE|DROP|ALTER)\s+FUNCTION[^;]*bootstrap_initial_admin/);
    expect(content).not.toMatch(/(GRANT|REVOKE)[^;]*bootstrap_initial_admin/);
    expect(content).not.toContain('DROP TABLE');
    expect(content).not.toContain('DROP FUNCTION');
    expect(content).not.toContain('ALTER TABLE public.admin_users');
    expect(content).not.toContain('ALTER TABLE public.user_roles');
  });

  it('creates the provisioning state machine table with row level security', () => {
    expect(content).toContain('CREATE TABLE public.staff_provisioning_requests');
    expect(content).toContain('ALTER TABLE public.staff_provisioning_requests ENABLE ROW LEVEL SECURITY');
    expect(squashed).toContain(
      "CREATE POLICY admin_all_staff_provisioning_requests ON public.staff_provisioning_requests FOR ALL TO authenticated USING (false) WITH CHECK (false)",
    );
  });

  it('constrains the lifecycle to the exact declared states', () => {
    expect(squashed).toContain(
      "status IN ('reserved', 'invited', 'pending_activation', 'activated', 'failed', 'compensation_failed')",
    );
  });

  it('enforces one authoritative lifecycle per normalized identity and per Auth identity', () => {
    expect(squashed).toContain(
      'CREATE UNIQUE INDEX staff_provisioning_requests_active_email_uidx ON public.staff_provisioning_requests(normalized_email) WHERE status IN (\'reserved\', \'invited\', \'pending_activation\', \'activated\')',
    );
    expect(squashed).toContain(
      'CREATE UNIQUE INDEX staff_provisioning_requests_active_auth_user_uidx ON public.staff_provisioning_requests(auth_user_id) WHERE auth_user_id IS NOT NULL AND status IN (\'invited\', \'pending_activation\', \'activated\')',
    );
  });

  it('serializes competing attempts on the normalized identity before any existence check', () => {
    expect(content).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(content).toContain("'capstone.staff_provisioning:' || v_email");
  });

  it('bounds the recorded failure code so free text can never carry a secret', () => {
    expect(squashed).toContain("failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'");
  });

  it('stores no password, token or session material', () => {
    for (const forbidden of ['password', 'token', 'refresh', 'secret', 'service_role_key']) {
      expect(content.toLowerCase()).not.toContain(`${forbidden} text`);
    }
    expect(content).not.toContain('encrypted_password');
  });

  it('hardens every privileged function identically', () => {
    for (const signature of PRIVILEGED_FUNCTIONS) {
      const bare = signature.replace(/\s/g, '');
      expect(squashed.replace(/\s/g, '')).toContain(`REVOKEALLONFUNCTION${bare}FROMPUBLIC,anon,authenticated;`);
      expect(squashed.replace(/\s/g, '')).toContain(`GRANTEXECUTEONFUNCTION${bare}TOservice_role;`);
    }
    const definerCount = (content.match(/SECURITY DEFINER/g) ?? []).length;
    const searchPathCount = (content.match(/SET search_path = ''/g) ?? []).length;
    expect(definerCount).toBe(PRIVILEGED_FUNCTIONS.length);
    // Every SECURITY DEFINER function plus the IMMUTABLE canonical-role helper pins search_path.
    expect(searchPathCount).toBe(PRIVILEGED_FUNCTIONS.length + 1);
  });

  it('grants the provisioning table read-only to service_role and nothing to browsers', () => {
    expect(squashed).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.staff_provisioning_requests FROM PUBLIC, anon, authenticated, service_role',
    );
    expect(squashed).toContain('GRANT SELECT ON TABLE public.staff_provisioning_requests TO service_role');
    expect(squashed).not.toContain('GRANT INSERT ON TABLE public.staff_provisioning_requests');
    expect(squashed).not.toContain('GRANT UPDATE ON TABLE public.staff_provisioning_requests');
  });

  it('uses no dynamic SQL anywhere', () => {
    expect(content).not.toContain('EXECUTE format(');
    expect(content).not.toMatch(/\bEXECUTE\s+'/);
    expect(content).not.toMatch(/\bEXECUTE\s+v_/);
  });

  it('declares the canonical role order as an explicit domain rule', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.canonical_staff_roles');
    expect(squashed).toContain("ARRAY['admin', 'reviewer', 'editor']::text[]");
  });

  it('resolves acting authority from the database rather than any caller-supplied claim', () => {
    expect(squashed).toContain(
      'SELECT 1 FROM public.user_roles WHERE user_id = p_actor_admin_id AND role = \'admin\'',
    );
  });

  it('binds activation solely to the authenticated Auth identity', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.activate_staff_provisioning(p_auth_user_id uuid)');
    expect(squashed).toContain('WHERE auth_user_id = p_auth_user_id AND status IN (\'pending_activation\', \'activated\')');
    expect(content).toContain("'resultCode', 'ACTIVATION_MISMATCH'");
  });

  it('proves compensation eligibility from database evidence, not caller assertion', () => {
    expect(content).toContain('auth_identity_created boolean NOT NULL DEFAULT false');
    expect(content).toContain('v_created_by_attempt := v_auth_created_at >= v_request.created_at;');
  });

  it('refuses to retroactively fail an activated lifecycle', () => {
    expect(squashed).toContain("IF v_request.status = 'activated' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE'");
  });

  it('exposes only bounded result codes', () => {
    for (const code of [
      'PERMISSION_DENIED',
      'VALIDATION_FAILED',
      'ALREADY_PROVISIONED',
      'ALREADY_INVITED',
      'RESERVED',
      'RESUMED',
      'BOUND',
      'ALREADY_BOUND',
      'AUTH_USER_NOT_FOUND',
      'AUTH_EMAIL_MISMATCH',
      'REQUEST_NOT_FOUND',
      'INVALID_STATE',
      'SUCCESS',
      'ACTIVATED',
      'ALREADY_ACTIVATED',
      'ACTIVATION_MISMATCH',
    ]) {
      expect(content).toContain(`'${code}'`);
    }
  });
});
