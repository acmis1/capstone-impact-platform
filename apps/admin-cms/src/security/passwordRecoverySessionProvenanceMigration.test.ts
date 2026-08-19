import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('password recovery session provenance migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260819214431_password_recovery_session_provenance.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = content
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  it('is exactly migration 0029 and leaves all 28 former migrations byte-identical', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(29);
    expect(files[28]).toBe(filename);

    for (const inherited of files.slice(0, 28)) {
      const local = fs.readFileSync(path.join(migrations, inherited), 'utf8').replace(/\r\n/g, '\n');
      const base = execFileSync(
        'git', ['show', `origin/main:infra/supabase/migrations/${inherited}`],
        { cwd: root, encoding: 'utf8' },
      ).replace(/\r\n/g, '\n');
      expect(crypto.createHash('sha256').update(local).digest('hex')).toBe(
        crypto.createHash('sha256').update(base).digest('hex'),
      );
    }
  });

  it('creates only the narrowly scoped ledger columns with fixed recovery purpose', () => {
    expect(compact).toContain(
      "CREATE TABLE public.password_recovery_sessions ( session_id uuid PRIMARY KEY",
    );
    for (const column of [
      'session_id uuid PRIMARY KEY',
      'auth_user_id uuid NOT NULL',
      "purpose text NOT NULL DEFAULT 'password_recovery'",
      'created_at timestamptz NOT NULL DEFAULT pg_catalog.now()',
    ]) {
      expect(compact).toContain(column);
    }
    expect(compact).toContain("CHECK (purpose = 'password_recovery')");
    expect(compact).not.toMatch(
      /\b(email|name|role|access_token|refresh_token|otp|token_hash|password|ip_address|user_agent|raw_jwt|cookie_value|provider_error|workflow_status)\s+(text|json|jsonb|uuid|inet)/i,
    );
  });

  it('binds both Supabase Auth primary keys with session-lifetime cascades', () => {
    expect(compact).toContain('REFERENCES auth.sessions(id) ON DELETE CASCADE');
    expect(compact).toContain('REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(executable.match(/ON DELETE CASCADE/g)).toHaveLength(2);
  });

  it('enables fail-closed RLS and denies every direct Data API role', () => {
    expect(compact).toContain(
      'ALTER TABLE public.password_recovery_sessions ENABLE ROW LEVEL SECURITY',
    );
    expect(compact).toContain(
      'CREATE POLICY deny_password_recovery_sessions_direct_access ON public.password_recovery_sessions AS RESTRICTIVE FOR ALL TO anon, authenticated, service_role USING (false) WITH CHECK (false)',
    );
    expect(compact).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.password_recovery_sessions FROM PUBLIC, anon, authenticated, service_role',
    );
    expect(compact).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*password_recovery_sessions/i);
  });

  it('makes registration service-role only, fixed-purpose, validated, and conflict-idempotent', () => {
    expect(compact).toContain(
      'CREATE OR REPLACE FUNCTION public.register_password_recovery_session( p_session_id uuid, p_auth_user_id uuid ) RETURNS jsonb',
    );
    expect(compact).toContain('FROM auth.sessions AS s WHERE s.id = p_session_id');
    expect(compact).toContain('FROM auth.users AS u WHERE u.id = p_auth_user_id');
    expect(compact).toContain(
      "INSERT INTO public.password_recovery_sessions (session_id, auth_user_id, purpose) VALUES (p_session_id, p_auth_user_id, 'password_recovery') ON CONFLICT (session_id) DO NOTHING",
    );
    for (const code of [
      'REGISTERED', 'ALREADY_REGISTERED', 'SESSION_NOT_FOUND',
      'SESSION_USER_MISMATCH', 'VALIDATION_FAILED',
    ]) {
      expect(executable).toContain(`'${code}'`);
    }
    expect(compact).toContain(
      'REVOKE ALL ON FUNCTION public.register_password_recovery_session(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role',
    );
    expect(compact).toContain(
      'GRANT EXECUTE ON FUNCTION public.register_password_recovery_session(uuid, uuid) TO service_role',
    );
    expect(compact).not.toMatch(/UPDATE\s+(auth\.|public\.password_recovery_sessions)/i);
    expect(compact).not.toMatch(/DELETE\s+FROM\s+(auth\.|public\.password_recovery_sessions)/i);
  });

  it('makes the no-argument lookup authenticated-only and derives both verified identities', () => {
    expect(compact).toContain(
      'CREATE OR REPLACE FUNCTION public.get_current_password_recovery_session_state() RETURNS jsonb',
    );
    expect(compact).toContain('v_claims := auth.jwt()');
    expect(compact).toContain('v_auth_user_id := auth.uid()');
    expect(compact).toContain("v_session_id_text := v_claims ->> 'session_id'");
    expect(compact).toContain('v_session_id := v_session_id_text::uuid');
    expect(compact).toContain('EXCEPTION WHEN invalid_text_representation THEN');
    expect(compact).toContain('JOIN auth.sessions AS s ON s.id = prs.session_id AND s.user_id = prs.auth_user_id');
    for (const code of ['RECOVERY_SESSION', 'NOT_REGISTERED', 'INVALID_CONTEXT']) {
      expect(executable).toContain(`'${code}'`);
    }
    expect(compact).toContain(
      'REVOKE ALL ON FUNCTION public.get_current_password_recovery_session_state() FROM PUBLIC, anon, authenticated, service_role',
    );
    expect(compact).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_current_password_recovery_session_state() TO authenticated',
    );
    expect(compact).not.toContain(
      'GRANT EXECUTE ON FUNCTION public.get_current_password_recovery_session_state() TO service_role',
    );
  });

  it('hardens both privileged functions without dynamic SQL or Auth hooks', () => {
    expect(executable.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(executable.match(/SET search_path = ''/g)).toHaveLength(2);
    const withoutAcls = executable
      .split('\n')
      .filter((line) => !/^\s*(GRANT|REVOKE)\b/i.test(line))
      .join('\n');
    expect(withoutAcls).not.toMatch(/\bEXECUTE\b|format\s*\(/i);
    expect(executable).not.toMatch(/CREATE\s+TRIGGER|ALTER\s+TABLE\s+auth\.|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+auth\./i);
    expect(executable).not.toMatch(/INSERT\s+INTO\s+auth\.|UPDATE\s+auth\.|DELETE\s+FROM\s+auth\./i);
    expect(executable).not.toMatch(/GRANT\s+EXECUTE[^;]*TO\s+PUBLIC/i);
  });
});
