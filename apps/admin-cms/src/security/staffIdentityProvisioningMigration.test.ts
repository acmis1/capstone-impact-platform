import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

const PRIVILEGED_FUNCTIONS = [
  'public.reserve_staff_provisioning(uuid, text, text, text[])',
  'public.recover_staff_provisioning_identity(uuid, uuid)',
  'public.bind_staff_provisioning_identity(uuid, uuid, uuid)',
  'public.finalize_staff_provisioning(uuid, uuid)',
  'public.begin_staff_provisioning_compensation(uuid, uuid, uuid)',
  'public.activate_staff_provisioning(uuid)',
  'public.fail_staff_provisioning(uuid, uuid, text, text)',
] as const;

describe('staff identity provisioning migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260813120000_staff_identity_provisioning.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8');
  const squashed = content.replace(/\s+/g, ' ');
  const compact = squashed.replace(/\s/g, '');

  it('is the exact twenty-second migration in the authoritative inventory', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(23);
    expect(files[21]).toBe(filename);
  });

  it('leaves migrations 0001-0021 and bootstrap_initial_admin untouched', () => {
    expect(content).not.toMatch(/(CREATE OR REPLACE|DROP|ALTER)\s+FUNCTION[^;]*bootstrap_initial_admin/);
    expect(content).not.toMatch(/(GRANT|REVOKE)[^;]*bootstrap_initial_admin/);
    expect(content).not.toContain('DROP TABLE');
    expect(content).not.toContain('DROP FUNCTION');
    expect(content).not.toContain('ALTER TABLE public.admin_users');
    expect(content).not.toContain('ALTER TABLE public.user_roles');
  });

  it('creates the RLS-protected durable lifecycle with the exact states', () => {
    expect(content).toContain('CREATE TABLE public.staff_provisioning_requests');
    expect(content).toContain('ALTER TABLE public.staff_provisioning_requests ENABLE ROW LEVEL SECURITY');
    for (const state of [
      'reserved', 'invited', 'pending_activation', 'activated', 'compensating', 'failed',
      'compensation_failed',
    ]) {
      expect(content).toContain(`'${state}'`);
    }
  });

  it('enforces one authoritative lifecycle and Auth binding per live identity', () => {
    expect(squashed).toContain(
      "CREATE UNIQUE INDEX staff_provisioning_requests_active_email_uidx ON public.staff_provisioning_requests(normalized_email) WHERE status IN ('reserved', 'invited', 'pending_activation', 'activated', 'compensating')",
    );
    expect(squashed).toContain(
      "CREATE UNIQUE INDEX staff_provisioning_requests_active_auth_user_uidx ON public.staff_provisioning_requests(auth_user_id) WHERE auth_user_id IS NOT NULL AND status IN ('invited', 'pending_activation', 'activated', 'compensating')",
    );
  });

  it('stores only hashes of both raw ownership credentials and uses a two-minute lease', () => {
    expect(content).toContain('execution_token_hash text NOT NULL');
    expect(content).toContain('auth_ownership_token_hash text NOT NULL');
    expect(content).toContain("extensions.digest(pg_catalog.convert_to(v_execution_token::text, 'UTF8'), 'sha256')");
    expect(content).toContain("extensions.digest(pg_catalog.convert_to(v_auth_ownership_token::text, 'UTF8'), 'sha256')");
    expect(content).toContain("lease_expires_at = pg_catalog.now() + interval '2 minutes'");
    expect(content).not.toMatch(/\bexecution_token\s+uuid\s+NOT NULL/);
    expect(content).not.toMatch(/\bauth_ownership_token\s+uuid\s+NOT NULL/);
  });

  it('returns distinct execution authority for normal and compensation expired-lease recovery', () => {
    expect(content).toContain("'resultCode', 'RESERVED'");
    expect(content).toContain("THEN 'RECOVERED_COMPENSATION' ELSE 'RECOVERED' END");
    expect(content).toContain("'resultCode', 'IN_PROGRESS'");
    expect(squashed).toContain("v_existing.lease_expires_at > pg_catalog.now()");
    expect(squashed).toContain('SET execution_token_hash = pg_catalog.encode(');
    expect(content).toContain("'COMPENSATION_ALREADY_COMPLETE'");
  });

  it('consumes transient Auth markers and establishes server-controlled app metadata atomically', () => {
    expect(content).toContain('CREATE TRIGGER claim_staff_provisioning_auth_insert_before_insert');
    expect(content).toContain("- 'staff_provisioning_request_id'");
    expect(content).toContain("- 'staff_provisioning_ownership_token'");
    expect(content).toContain("NEW.raw_app_meta_data := COALESCE(NEW.raw_app_meta_data, '{}'::jsonb)");
    expect(content).toContain("'staff_provisioning_marker'");
    expect(content).toContain("'STAFF_PROVISIONING_INVITE_NOT_OWNED'");
    expect(content).toContain("raw_app_meta_data->>'staff_provisioning_marker'");
    expect(content).not.toContain("raw_app_meta_data->>'staff_provisioning_request_id'");
  });

  it('never infers Auth ownership from creation time', () => {
    expect(content).toContain('auth_identity_owned boolean NOT NULL DEFAULT false');
    expect(content).not.toContain('auth_identity_created');
    expect(content).not.toMatch(/created_at\s*>?=\s*v_request\.created_at/);
  });

  it('protects recover, bind, finalize, compensation and failure with the current token and lease', () => {
    expect((content.match(/'EXECUTION_TOKEN_MISMATCH'/g) ?? [])).toHaveLength(5);
    expect((content.match(/'EXECUTION_LEASE_EXPIRED'/g) ?? [])).toHaveLength(5);
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.begin_staff_provisioning_compensation');
    expect(content).toContain("status = 'compensating'");
    expect(content).toContain("'COMPENSATION_NOT_AUTHORIZED'");
    expect(content).toContain("'COMPENSATION_NOT_CONFIRMED'");
  });

  it('keeps activation bound only to the authenticated Auth identity and independent of owner tokens', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.activate_staff_provisioning(p_auth_user_id uuid)');
    expect(squashed).toContain(
      "WHERE auth_user_id = p_auth_user_id AND status IN ('pending_activation', 'activated')",
    );
    expect(content).toContain("'resultCode', 'ACTIVATION_MISMATCH'");
  });

  it('hardens every privileged function and makes the Auth trigger non-callable', () => {
    for (const signature of PRIVILEGED_FUNCTIONS) {
      const bare = signature.replace(/\s/g, '');
      expect(compact).toContain(`REVOKEALLONFUNCTION${bare}FROMPUBLIC,anon,authenticated;`);
      expect(compact).toContain(`GRANTEXECUTEONFUNCTION${bare}TOservice_role;`);
    }
    expect(compact).toContain(
      'REVOKEALLONFUNCTIONpublic.claim_staff_provisioning_auth_insert()FROMPUBLIC,anon,authenticated,service_role;',
    );
    expect((content.match(/SECURITY DEFINER/g) ?? [])).toHaveLength(PRIVILEGED_FUNCTIONS.length + 1);
    expect((content.match(/SET search_path = ''/g) ?? [])).toHaveLength(PRIVILEGED_FUNCTIONS.length + 2);
  });

  it('grants the evidence table read-only to service_role and nothing to browsers', () => {
    expect(squashed).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.staff_provisioning_requests FROM PUBLIC, anon, authenticated, service_role',
    );
    expect(squashed).toContain('GRANT SELECT ON TABLE public.staff_provisioning_requests TO service_role');
    expect(squashed).not.toContain('GRANT INSERT ON TABLE public.staff_provisioning_requests');
    expect(squashed).not.toContain('GRANT UPDATE ON TABLE public.staff_provisioning_requests');
  });

  it('uses bounded failure codes and no credential-bearing application columns', () => {
    expect(squashed).toContain("failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'");
    expect(content).not.toContain('encrypted_password');
    for (const forbidden of ['invite_token', 'access_token', 'refresh_token', 'magic_link_token']) {
      expect(content).not.toContain(`${forbidden} text`);
    }
  });

  it('uses no dynamic SQL', () => {
    expect(content).not.toContain('EXECUTE format(');
    expect(content).not.toMatch(/\bEXECUTE\s+'/);
    expect(content).not.toMatch(/\bEXECUTE\s+v_/);
  });

  it('preserves canonical roles and authoritative staff.manage authority', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.canonical_staff_roles');
    expect(squashed).toContain("ARRAY['admin', 'reviewer', 'editor']::text[]");
    expect(squashed).toContain(
      "SELECT 1 FROM public.user_roles WHERE user_id = p_actor_admin_id AND role = 'admin'",
    );
  });
});
