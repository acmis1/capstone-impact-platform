import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('staging UAT direct-account migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const historicalFilename = '20260813120000_staff_identity_provisioning.sql';
  const filename = '20260816144917_staging_uat_direct_account_finalization.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8');
  const squashed = content.replace(/\s+/g, ' ');
  const compact = content.replace(/\s/g, '');

  it('is the single twenty-seventh forward migration', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(35);
    expect(files[26]).toBe(filename);
  });

  it('leaves the canonical historical staff provisioning migration content unchanged', () => {
    const historical = fs
      .readFileSync(path.join(migrations, historicalFilename), 'utf8')
      .replace(/\r\n?/g, '\n');
    expect(createHash('sha256').update(historical).digest('hex')).toBe(
      '9c229853044b2a52cda2fd9cc131b6bc1cca7c5eee5b8522cc05df70558ba397',
    );
  });

  it('creates one hardened service-role-only SECURITY DEFINER RPC', () => {
    const signature = 'public.finalize_and_activate_staff_provisioning(uuid,uuid)';
    expect(content).toContain(
      'CREATE OR REPLACE FUNCTION public.finalize_and_activate_staff_provisioning',
    );
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("SET search_path = ''");
    expect(compact).toContain(
      `REVOKEALLONFUNCTION${signature}FROMPUBLIC,anon,authenticated,service_role;`,
    );
    expect(compact).toContain(`GRANTEXECUTEONFUNCTION${signature}TOservice_role;`);
    expect(content.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
  });

  it('requires the current execution token, lease and exact invited ownership state', () => {
    expect(content).toContain("'EXECUTION_TOKEN_MISMATCH'");
    expect(content).toContain("'EXECUTION_LEASE_EXPIRED'");
    expect(squashed).toContain("v_request.status <> 'invited'");
    expect(squashed).toContain('v_request.auth_user_id IS NULL');
    expect(squashed).toContain('v_request.auth_identity_owned = false');
  });

  it('rejects Administrator and any role outside Reviewer or Editor in the database', () => {
    expect(squashed).toContain(
      "v_request.requested_roles <@ ARRAY['reviewer', 'editor']::text[]",
    );
    expect(content).toContain("'ROLE_NOT_ALLOWED'");
    expect(content).not.toContain("ARRAY['admin', 'reviewer', 'editor']");
  });

  it('re-proves Auth email and the exact durable request marker before profile mutation', () => {
    expect(content).toContain("raw_app_meta_data->>'staff_provisioning_marker'");
    expect(content).toContain("extensions.digest(pg_catalog.convert_to(v_request.id::text, 'UTF8'), 'sha256')");
    expect(content).toContain("'AUTH_EMAIL_MISMATCH'");
    expect(content).toContain("'AUTH_OWNERSHIP_MISMATCH'");
    expect(content).not.toContain('created_at >=');
  });

  it('strips raw ownership credentials from createUser metadata updates as well as inserts', () => {
    expect(squashed).toContain(
      'BEFORE UPDATE OF raw_user_meta_data ON auth.users FOR EACH ROW EXECUTE FUNCTION public.claim_staff_provisioning_auth_insert()',
    );
  });

  it('rejects split email/Auth collisions before exact profile reuse', () => {
    expect((content.match(/IS DISTINCT FROM v_request\.auth_user_id/g) ?? [])).not.toHaveLength(0);
    expect(content).toContain(
      'pg_catalog.lower(pg_catalog.btrim(email)) IS DISTINCT FROM v_request.normalized_email',
    );
    expect(content).toContain("'ALREADY_PROVISIONED'");
  });

  it('creates profile and roles then transitions directly to activated in the same RPC', () => {
    expect(content).toContain('INSERT INTO public.admin_users');
    expect(content).toContain('INSERT INTO public.user_roles');
    expect(squashed).toContain("status = 'activated'");
    expect(squashed).toContain('activated_at = pg_catalog.now()');
    expect(squashed).toContain('lease_expires_at = pg_catalog.now()');
    expect(content).toContain("'status', 'activated'");
    expect(content).not.toContain('pending_activation');
    expect(content).not.toMatch(/\b(?:PERFORM|SELECT)\s+public\.finalize_staff_provisioning\s*\(/);
    expect(content).not.toMatch(/\b(?:PERFORM|SELECT)\s+public\.activate_staff_provisioning\s*\(/);
  });

  it('stores no password, credential, or raw ownership token', () => {
    for (const forbidden of [
      'encrypted_password',
      'password text',
      'execution_token text',
      'auth_ownership_token text',
      'staff_provisioning_ownership_token',
    ]) {
      expect(content).not.toContain(forbidden);
    }
  });
});
