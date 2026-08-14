import { describe, it, expect } from 'vitest';
import {
  validateStagingGuard,
  isValidMutationConfirmationLabel,
} from './stagingExecutionGuard';

describe('Shared Staging Target Guard Tests', () => {
  const validStagingEnv = {
    CAPSTONE_RUNTIME_ENV: 'staging',
    CAPSTONE_EXPECTED_SUPABASE_HOST: 'app-staging.supabase.co',
    NEXT_PUBLIC_SUPABASE_URL: 'https://app-staging.supabase.co',
  };

  const validMutatingStagingEnv = {
    ...validStagingEnv,
    CAPSTONE_STAGING_MUTATION_CONFIRMATION: 'capstone-admin-cms-staging-2026',
  };

  const validV2MutatingStagingEnv = {
    ...validStagingEnv,
    CAPSTONE_STAGING_MUTATION_CONFIRMATION: 'capstone-admin-cms-staging-v2-2026',
  };

  describe('Label Validation Unit Tests', () => {
    it('validates allowed staging confirmation label patterns', () => {
      expect(isValidMutationConfirmationLabel('capstone-admin-cms-staging-2026')).toBe(true);
      expect(isValidMutationConfirmationLabel('capstone-admin-cms-staging-v2-2026')).toBe(true);
      expect(isValidMutationConfirmationLabel('staging-1')).toBe(true);
      expect(isValidMutationConfirmationLabel('staging')).toBe(true);
      expect(isValidMutationConfirmationLabel('s')).toBe(true);
      expect(isValidMutationConfirmationLabel('a-b-c-1-2-3')).toBe(true);
    });

    it('rejects disallowed confirmation labels', () => {
      expect(isValidMutationConfirmationLabel('')).toBe(false);
      expect(isValidMutationConfirmationLabel('   ')).toBe(false);
      expect(isValidMutationConfirmationLabel('-staging')).toBe(false);
      expect(isValidMutationConfirmationLabel('staging-')).toBe(false);
      expect(isValidMutationConfirmationLabel('STAGING-V2')).toBe(false);
      expect(isValidMutationConfirmationLabel('staging_v2')).toBe(false);
      expect(isValidMutationConfirmationLabel('staging v2')).toBe(false);
      expect(isValidMutationConfirmationLabel('staging\nv2')).toBe(false);
      expect(isValidMutationConfirmationLabel('https://app-staging.supabase.co')).toBe(false);
      expect(isValidMutationConfirmationLabel('a'.repeat(65))).toBe(false);
    });
  });

  describe('Read-Only Staging Operations', () => {
    it('1. Valid read-only staging identity authorizes read-only operation cleanly without CAPSTONE_STAGING_MUTATION_CONFIRMATION', () => {
      const result = validateStagingGuard({
        operationId: 'check-staging-projects',
        args: [],
        customEnv: validStagingEnv,
      });

      expect(result.isAuthorized).toBe(true);
      expect(result.isMutating).toBe(false);
    });

    it('2. Read-only operation still rejects mutation flags (--apply and --confirm-staging)', () => {
      expect(() =>
        validateStagingGuard({
          operationId: 'check-staging-projects',
          args: ['--apply'],
          customEnv: validStagingEnv,
        })
      ).toThrowError(/Staging Guard Violation: Read-only staging operations cannot accept mutation flags/);

      expect(() =>
        validateStagingGuard({
          operationId: 'check-staging-projects',
          args: ['--confirm-staging=capstone-admin-cms-staging-2026'],
          customEnv: validStagingEnv,
        })
      ).toThrowError(/Staging Guard Violation: Read-only staging operations cannot accept mutation flags/);
    });
  });

  describe('Runtime Environment & Target Hostname Identity Boundary', () => {
    it('3. Missing CAPSTONE_RUNTIME_ENV identity throws sanitized refusal error', () => {
      const env = { ...validMutatingStagingEnv };
      delete (env as Record<string, string | undefined>).CAPSTONE_RUNTIME_ENV;

      expect(() =>
        validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
      ).toThrowError(/Staging Execution Refused: Environment identity is not configured/);
    });

    it('4. Wrong/production CAPSTONE_RUNTIME_ENV identity throws sanitized refusal error', () => {
      const env = { ...validMutatingStagingEnv, CAPSTONE_RUNTIME_ENV: 'production' };

      expect(() =>
        validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
      ).toThrowError(/Staging Execution Refused: Environment identity is not configured/);
    });

    it('5. Missing expected target hostname throws sanitized refusal error', () => {
      const env = { ...validMutatingStagingEnv };
      delete (env as Record<string, string | undefined>).CAPSTONE_EXPECTED_SUPABASE_HOST;

      expect(() =>
        validateStagingGuard({ operationId: 'check-staging-projects', args: [], customEnv: env })
      ).toThrowError(/Staging Execution Refused: Expected target hostname is not configured/);
    });

    it('6. Hostname mismatch throws sanitized refusal error without echoing hostnames in error text', () => {
      const env = {
        ...validMutatingStagingEnv,
        NEXT_PUBLIC_SUPABASE_URL: 'https://other-project.supabase.co',
      };

      expect(() =>
        validateStagingGuard({ operationId: 'seed-staging-projects', args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'], customEnv: env })
      ).toThrowError(/Staging Execution Refused: Target hostname does not match expected staging target identity/);

      try {
        validateStagingGuard({ operationId: 'seed-staging-projects', args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'], customEnv: env });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).not.toContain('other-project.supabase.co');
        expect(msg).not.toContain('app-staging.supabase.co');
      }
    });

    it('7. Loopback endpoints (localhost, 127.0.0.1, ::1) are strictly rejected for staging operations even with valid confirmation', () => {
      const loopbacks = ['https://localhost', 'https://127.0.0.1', 'https://[::1]'];

      for (const url of loopbacks) {
        const env = {
          CAPSTONE_RUNTIME_ENV: 'staging',
          CAPSTONE_EXPECTED_SUPABASE_HOST: new URL(url).hostname,
          NEXT_PUBLIC_SUPABASE_URL: url,
          CAPSTONE_STAGING_MUTATION_CONFIRMATION: 'capstone-admin-cms-staging-2026',
        };

        expect(() =>
          validateStagingGuard({
            operationId: 'seed-staging-projects',
            args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'],
            customEnv: env,
          })
        ).toThrowError(/Staging Execution Refused: Staging operations cannot target loopback endpoints/);
      }
    });

    it('8. Insecure HTTP URLs are strictly rejected for staging operations even with valid confirmation', () => {
      const env = {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'app-staging.supabase.co',
        NEXT_PUBLIC_SUPABASE_URL: 'http://app-staging.supabase.co',
        CAPSTONE_STAGING_MUTATION_CONFIRMATION: 'capstone-admin-cms-staging-2026',
      };

      expect(() =>
        validateStagingGuard({
          operationId: 'seed-staging-projects',
          args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'],
          customEnv: env,
        })
      ).toThrowError(/Staging Execution Refused: Target URL must use secure HTTPS protocol/);
    });
  });

  describe('Mutating Operations — Environment-Portable Confirmation & Fail-Closed Behavior', () => {
    it('9. Mutating operation fails closed if CAPSTONE_STAGING_MUTATION_CONFIRMATION is missing', () => {
      const env = { ...validStagingEnv };
      delete (env as Record<string, string | undefined>).CAPSTONE_STAGING_MUTATION_CONFIRMATION;

      expect(() =>
        validateStagingGuard({
          operationId: 'seed-staging-projects',
          args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'],
          customEnv: env,
        })
      ).toThrowError(/Staging Execution Refused: Staging mutation confirmation environment variable \(CAPSTONE_STAGING_MUTATION_CONFIRMATION\) is not configured\./);
    });

    it('10. Mutating operation fails closed if CAPSTONE_STAGING_MUTATION_CONFIRMATION is blank or whitespace-only', () => {
      const envs = [
        { ...validStagingEnv, CAPSTONE_STAGING_MUTATION_CONFIRMATION: '' },
        { ...validStagingEnv, CAPSTONE_STAGING_MUTATION_CONFIRMATION: '   ' },
        { ...validStagingEnv, CAPSTONE_STAGING_MUTATION_CONFIRMATION: '\t\n' },
      ];

      for (const env of envs) {
        expect(() =>
          validateStagingGuard({
            operationId: 'seed-staging-projects',
            args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'],
            customEnv: env,
          })
        ).toThrowError(/Staging Execution Refused: Staging mutation confirmation environment variable \(CAPSTONE_STAGING_MUTATION_CONFIRMATION\) is not configured\./);
      }
    });

    it('11. Malformed confirmation configuration in environment is strictly rejected', () => {
      const malformedConfigs = [
        'STAGING-UPPERCASE',
        'staging_with_underscore',
        '-leading-hyphen',
        'trailing-hyphen-',
        'has spaces in label',
        'https://app-staging.supabase.co',
        'a'.repeat(65),
      ];

      for (const malformed of malformedConfigs) {
        const env = { ...validStagingEnv, CAPSTONE_STAGING_MUTATION_CONFIRMATION: malformed };

        expect(() =>
          validateStagingGuard({
            operationId: 'seed-staging-projects',
            args: ['--apply', `--confirm-staging=${malformed}`],
            customEnv: env,
          })
        ).toThrowError(/Staging Execution Refused: Staging mutation confirmation environment variable \(CAPSTONE_STAGING_MUTATION_CONFIRMATION\) format is invalid\./);
      }
    });

    it('12. Mutating operation with --apply but without --confirm-staging remains unauthorized (dry-run)', () => {
      const result = validateStagingGuard({
        operationId: 'seed-staging-projects',
        args: ['--apply'],
        customEnv: validMutatingStagingEnv,
      });

      expect(result.isAuthorized).toBe(false);
      expect(result.isMutating).toBe(true);
      expect(result.dryRunReason).toContain('Missing required mutation acknowledgement flags');
      expect(result.dryRunReason).toContain('capstone-admin-cms-staging-2026');
    });

    it('13. Mutating operation with --confirm-staging but without --apply remains unauthorized (dry-run)', () => {
      const result = validateStagingGuard({
        operationId: 'seed-staging-projects',
        args: ['--confirm-staging=capstone-admin-cms-staging-2026'],
        customEnv: validMutatingStagingEnv,
      });

      expect(result.isAuthorized).toBe(false);
      expect(result.isMutating).toBe(true);
      expect(result.dryRunReason).toContain('Missing required mutation acknowledgement flags');
    });

    it('14. Mutating operation with wrong confirmation value remains unauthorized (dry-run)', () => {
      const result = validateStagingGuard({
        operationId: 'seed-staging-projects',
        args: ['--apply', '--confirm-staging=wrong-confirmation'],
        customEnv: validMutatingStagingEnv,
      });

      expect(result.isAuthorized).toBe(false);
      expect(result.isMutating).toBe(true);
      expect(result.dryRunReason).toContain('Missing required mutation acknowledgement flags');
    });

    it('15. Exact confirmation + --apply + correct host authorizes mutating operation', () => {
      const result = validateStagingGuard({
        operationId: 'seed-staging-projects',
        args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'],
        customEnv: validMutatingStagingEnv,
      });

      expect(result.isAuthorized).toBe(true);
      expect(result.isMutating).toBe(true);
    });

    it('16. A second legitimate staging label (e.g. capstone-admin-cms-staging-v2-2026) works WITHOUT source-code modification', () => {
      const result = validateStagingGuard({
        operationId: 'seed-staging-projects',
        args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-v2-2026'],
        customEnv: validV2MutatingStagingEnv,
      });

      expect(result.isAuthorized).toBe(true);
      expect(result.isMutating).toBe(true);
    });

    it('17. Mutation acknowledgement cannot bypass technical target identity boundary', () => {
      const mismatchedEnv = {
        ...validMutatingStagingEnv,
        NEXT_PUBLIC_SUPABASE_URL: 'https://attacker-project.supabase.co',
      };

      expect(() =>
        validateStagingGuard({
          operationId: 'seed-staging-projects',
          args: ['--apply', '--confirm-staging=capstone-admin-cms-staging-2026'],
          customEnv: mismatchedEnv,
        })
      ).toThrowError(/Staging Execution Refused: Target hostname does not match expected staging target identity/);
    });
  });
});
