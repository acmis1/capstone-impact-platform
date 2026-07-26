import { describe, it, expect } from 'vitest';
import { validateStagingGuard, REQUIRED_MUTATION_CONFIRMATION } from './stagingExecutionGuard';

describe('Shared Staging Target Guard Tests', () => {
  const validStagingEnv = {
    CAPSTONE_RUNTIME_ENV: 'staging',
    CAPSTONE_EXPECTED_SUPABASE_HOST: 'app-staging.supabase.co',
    NEXT_PUBLIC_SUPABASE_URL: 'https://app-staging.supabase.co',
  };

  it('1. Valid read-only staging identity authorizes read-only operation cleanly', () => {
    const result = validateStagingGuard({
      operationId: 'check-staging-projects',
      args: [],
      customEnv: validStagingEnv,
    });

    expect(result.isAuthorized).toBe(true);
    expect(result.isMutating).toBe(false);
  });

  it('2. Read-only operation throws if mutation flags are passed', () => {
    expect(() =>
      validateStagingGuard({
        operationId: 'check-staging-projects',
        args: ['--apply'],
        customEnv: validStagingEnv,
      })
    ).toThrowError(/Staging Guard Violation: Read-only staging operations cannot accept mutation flags/);
  });

  it('3. Missing CAPSTONE_RUNTIME_ENV identity throws sanitized refusal error', () => {
    const env = { ...validStagingEnv };
    delete (env as Record<string, string | undefined>).CAPSTONE_RUNTIME_ENV;

    expect(() =>
      validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
    ).toThrowError(/Staging Execution Refused: Environment identity is not configured/);
  });

  it('4. Wrong CAPSTONE_RUNTIME_ENV identity throws sanitized refusal error', () => {
    const env = { ...validStagingEnv, CAPSTONE_RUNTIME_ENV: 'production' };

    expect(() =>
      validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
    ).toThrowError(/Staging Execution Refused: Environment identity is not configured/);
  });

  it('5. Missing expected target hostname throws sanitized refusal error', () => {
    const env = { ...validStagingEnv };
    delete (env as Record<string, string | undefined>).CAPSTONE_EXPECTED_SUPABASE_HOST;

    expect(() =>
      validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
    ).toThrowError(/Staging Execution Refused: Expected target hostname is not configured/);
  });

  it('6. Hostname mismatch throws sanitized refusal error without echoing hostnames in error text', () => {
    const env = {
      ...validStagingEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://other-project.supabase.co',
    };

    expect(() =>
      validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
    ).toThrowError(/Staging Execution Refused: Target hostname does not match expected staging target identity/);

    try {
      validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain('other-project.supabase.co');
      expect(msg).not.toContain('app-staging.supabase.co');
    }
  });

  it('7. Loopback endpoints (localhost, 127.0.0.1, ::1) are strictly rejected for staging operations', () => {
    const loopbacks = ['https://localhost', 'https://127.0.0.1', 'https://[::1]'];

    for (const url of loopbacks) {
      const env = {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: new URL(url).hostname,
        NEXT_PUBLIC_SUPABASE_URL: url,
      };

      expect(() =>
        validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
      ).toThrowError(/Staging Execution Refused: Staging operations cannot target loopback endpoints/);
    }
  });

  it('8. Insecure HTTP URLs are strictly rejected for staging operations', () => {
    const env = {
      CAPSTONE_RUNTIME_ENV: 'staging',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'app-staging.supabase.co',
      NEXT_PUBLIC_SUPABASE_URL: 'http://app-staging.supabase.co',
    };

    expect(() =>
      validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
    ).toThrowError(/Staging Execution Refused: Target URL must use secure HTTPS protocol/);
  });

  it('9. Mutating operation without --apply returns dry-run refusal result without throwing', () => {
    const result = validateStagingGuard({
      operationId: 'seed-staging-projects',
      args: [`--confirm-staging=${REQUIRED_MUTATION_CONFIRMATION}`],
      customEnv: validStagingEnv,
    });

    expect(result.isAuthorized).toBe(false);
    expect(result.isMutating).toBe(true);
    expect(result.dryRunReason).toContain('Missing required mutation acknowledgement flags');
  });

  it('10. Mutating operation without exact confirmation value returns dry-run refusal result', () => {
    const result = validateStagingGuard({
      operationId: 'seed-staging-projects',
      args: ['--apply', '--confirm-staging=wrong-confirmation'],
      customEnv: validStagingEnv,
    });

    expect(result.isAuthorized).toBe(false);
    expect(result.isMutating).toBe(true);
    expect(result.dryRunReason).toContain('Missing required mutation acknowledgement flags');
  });

  it('11. Mutating operation with BOTH --apply and exact confirmation flag is fully authorized', () => {
    const result = validateStagingGuard({
      operationId: 'seed-staging-projects',
      args: ['--apply', `--confirm-staging=${REQUIRED_MUTATION_CONFIRMATION}`],
      customEnv: validStagingEnv,
    });

    expect(result.isAuthorized).toBe(true);
    expect(result.isMutating).toBe(true);
  });
});
