import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieMocks = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => cookieMocks.value === null
      ? undefined
      : { name: 'capstone_password_recovery_context', value: cookieMocks.value },
  }),
}));

import type { VerifiedAuthClaims } from './claims';
import {
  GET_CURRENT_PASSWORD_RECOVERY_SESSION_STATE_RPC,
  REGISTER_PASSWORD_RECOVERY_SESSION_RPC,
  classifyAdminAuthenticationProvenance,
  getVerifiedPasswordRecoveryAccess,
  getCurrentPasswordRecoverySessionState,
  hasRecoveryAcceptanceProvenance,
  hasSupportedAdminPasswordProvenance,
  parseRecoveryRegistrationResult,
  parseRecoverySessionState,
  registerPasswordRecoverySession,
} from './recoverySession';
import { signRecoveryContext } from './recoveryContext';

const CLAIMS: VerifiedAuthClaims = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  authenticationMethods: ['password'],
};

/**
 * The only verified single-method AMR sets accepted as recovery-entry provenance: `otp` is proven
 * by the Local custom TokenHash flow, and `recovery` is Supabase's documented account-recovery
 * method emitted by the hosted default-template PKCE exchange.
 */
const SUPPORTED_RECOVERY_METHODS = ['otp', 'recovery'] as const;

/** Every other documented, mixed, empty, or near-miss AMR set must fail closed. */
const UNSUPPORTED_RECOVERY_METHOD_SET_CASES: readonly [string[]][] = ([
  [],
  ['password'],
  ['invite'],
  ['magiclink'],
  ['email/signup'],
  ['email_change'],
  ['oauth'],
  ['totp'],
  ['sso/saml'],
  ['anonymous'],
  ['token_refresh'],
  ['unknown'],
  // Exact equality only - no prefix, suffix, substring, or case-insensitive matching.
  ['otp_extra'],
  ['recovery_code'],
  ['pre-otp'],
  ['account-recovery'],
  ['OTP'],
  ['RECOVERY'],
  // No multi-method set qualifies, including combinations of the two supported methods.
  ['otp', 'password'],
  ['recovery', 'password'],
  ['otp', 'recovery'],
  ['recovery', 'otp'],
  ['otp', 'otp'],
  ['password', 'recovery', 'otp'],
] as const).map((methods): [string[]] => [[...methods]]);

describe('password recovery session RPC contracts', () => {
  it.each([
    'REGISTERED',
    'ALREADY_REGISTERED',
    'SESSION_NOT_FOUND',
    'SESSION_USER_MISMATCH',
    'VALIDATION_FAILED',
  ] as const)('parses bounded registration result %s', (resultCode) => {
    expect(parseRecoveryRegistrationResult({ resultCode })).toBe(resultCode);
  });

  it.each(['RECOVERY_SESSION', 'NOT_REGISTERED', 'INVALID_CONTEXT'] as const)(
    'parses bounded lookup result %s',
    (resultCode) => {
      expect(parseRecoverySessionState({ resultCode })).toBe(resultCode);
    },
  );

  it.each([
    null,
    [],
    {},
    { resultCode: 'UNKNOWN' },
    { resultCode: 'RECOVERY_SESSION', sessionId: CLAIMS.sessionId },
  ])('rejects malformed or data-bearing bounded responses: %o', (value) => {
    expect(() => parseRecoverySessionState(value)).toThrow(
      'Password recovery session response is invalid.',
    );
  });

  it('registers only the verified user/session pair and accepts no caller purpose', async () => {
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      void name;
      void args;
      return { data: { resultCode: 'REGISTERED' }, error: null };
    });
    await expect(registerPasswordRecoverySession({ rpc }, CLAIMS)).resolves.toBe('REGISTERED');
    expect(rpc).toHaveBeenCalledWith(REGISTER_PASSWORD_RECOVERY_SESSION_RPC, {
      p_session_id: CLAIMS.sessionId,
      p_auth_user_id: CLAIMS.userId,
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('purpose');
  });

  it('calls the authenticated lookup with no caller-supplied arguments', async () => {
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      void name;
      void args;
      return { data: { resultCode: 'NOT_REGISTERED' }, error: null };
    });
    await expect(getCurrentPasswordRecoverySessionState({ rpc })).resolves.toBe('NOT_REGISTERED');
    expect(rpc).toHaveBeenCalledWith(GET_CURRENT_PASSWORD_RECOVERY_SESSION_STATE_RPC);
  });

  it('rejects RPC errors without exposing provider details', async () => {
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      void name;
      void args;
      return { data: null, error: { message: 'private provider detail' } };
    });
    await expect(getCurrentPasswordRecoverySessionState({ rpc })).rejects.toThrow(
      'Password recovery session lookup failed.',
    );
  });
});

describe('reset-page and reset-action recovery access boundary', () => {
  const secret = 'synthetic-auth-flow-secret-32-bytes-minimum';
  const originalSecret = process.env.CAPSTONE_AUTH_FLOW_SECRET;

  beforeEach(() => {
    cookieMocks.value = signRecoveryContext(CLAIMS.userId, CLAIMS.sessionId, {
      secret,
      nowSeconds: 1_800_000_000,
    });
    process.env.CAPSTONE_AUTH_FLOW_SECRET = secret;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_001 * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
    cookieMocks.value = null;
    if (originalSecret === undefined) delete process.env.CAPSTONE_AUTH_FLOW_SECRET;
    else process.env.CAPSTONE_AUTH_FLOW_SECRET = originalSecret;
  });

  function client(resultCode = 'RECOVERY_SESSION', method = 'otp') {
    return {
      auth: {
        getClaims: vi.fn(async () => ({
          data: {
            claims: {
              sub: CLAIMS.userId,
              session_id: CLAIMS.sessionId,
              amr: [{ method, timestamp: 1_800_000_000 }],
            },
          },
          error: null,
        })),
      },
      rpc: vi.fn(async () => ({ data: { resultCode }, error: null })),
    };
  }

  it.each(SUPPORTED_RECOVERY_METHODS)(
    'requires verified claims, durable state, exact %s provenance, and exact context binding',
    async (method) => {
      await expect(getVerifiedPasswordRecoveryAccess(client('RECOVERY_SESSION', method)))
        .resolves.toEqual({
          userId: CLAIMS.userId,
          sessionId: CLAIMS.sessionId,
          authenticationMethods: [method],
        });
    },
  );

  it.each(SUPPORTED_RECOVERY_METHODS)(
    'rejects %s provenance without durable state or with substituted context binding',
    async (method) => {
      // Durable ledger state is mandatory for both supported recovery AMRs.
      await expect(getVerifiedPasswordRecoveryAccess(client('NOT_REGISTERED', method)))
        .resolves.toBeNull();
      await expect(getVerifiedPasswordRecoveryAccess(client('INVALID_CONTEXT', method)))
        .resolves.toBeNull();

      // A valid durable row still cannot be unlocked by a context bound to another session.
      cookieMocks.value = signRecoveryContext(
        CLAIMS.userId,
        '33333333-3333-4333-8333-333333333333',
        { secret, nowSeconds: 1_800_000_000 },
      );
      await expect(getVerifiedPasswordRecoveryAccess(client('RECOVERY_SESSION', method)))
        .resolves.toBeNull();

      // Nor by a context bound to another user.
      cookieMocks.value = signRecoveryContext(
        '44444444-4444-4444-8444-444444444444',
        CLAIMS.sessionId,
        { secret, nowSeconds: 1_800_000_000 },
      );
      await expect(getVerifiedPasswordRecoveryAccess(client('RECOVERY_SESSION', method)))
        .resolves.toBeNull();

      // Nor by an absent context.
      cookieMocks.value = null;
      await expect(getVerifiedPasswordRecoveryAccess(client('RECOVERY_SESSION', method)))
        .resolves.toBeNull();
    },
  );

  it.each(UNSUPPORTED_RECOVERY_METHOD_SET_CASES)(
    'refuses recovery access for unsupported AMR %j even with durable state and valid context',
    async (authenticationMethods) => {
      const unsupported = {
        auth: {
          getClaims: vi.fn(async () => ({
            data: {
              claims: {
                sub: CLAIMS.userId,
                session_id: CLAIMS.sessionId,
                amr: authenticationMethods.map((method) => ({
                  method,
                  timestamp: 1_800_000_000,
                })),
              },
            },
            error: null,
          })),
        },
        rpc: vi.fn(async () => ({ data: { resultCode: 'RECOVERY_SESSION' }, error: null })),
      };
      await expect(getVerifiedPasswordRecoveryAccess(unsupported)).resolves.toBeNull();
    },
  );
});

describe('Admin authentication provenance truth table', () => {
  it.each(['absent', 'valid', 'invalid'] as const)(
    'blocks a durable recovery session when context is %s',
    (recoveryContext) => {
      expect(classifyAdminAuthenticationProvenance({
        claims: CLAIMS,
        recoveryState: 'RECOVERY_SESSION',
        recoveryContext,
      })).toBe('PASSWORD_RECOVERY_REQUIRED');
    },
  );

  it('allows only exact password AMR with no ledger row and no context', () => {
    expect(classifyAdminAuthenticationProvenance({
      claims: CLAIMS,
      recoveryState: 'NOT_REGISTERED',
      recoveryContext: 'absent',
    })).toBe('ALLOW_ADMIN');
  });

  it.each([
    { authenticationMethods: [] },
    { authenticationMethods: ['otp'] },
    { authenticationMethods: ['recovery'] },
    { authenticationMethods: ['invite'] },
    { authenticationMethods: ['magiclink'] },
    { authenticationMethods: ['unknown'] },
    { authenticationMethods: ['password', 'otp'] },
  ])('rejects unsupported AMR $authenticationMethods without a ledger row', ({ authenticationMethods }) => {
    expect(classifyAdminAuthenticationProvenance({
      claims: { ...CLAIMS, authenticationMethods },
      recoveryState: 'NOT_REGISTERED',
      recoveryContext: 'absent',
    })).toBe('AUTHENTICATION_PROVENANCE_INVALID');
  });

  it.each(['valid', 'invalid'] as const)(
    'rejects %s signed context without a matching durable row',
    (recoveryContext) => {
      expect(classifyAdminAuthenticationProvenance({
        claims: CLAIMS,
        recoveryState: 'NOT_REGISTERED',
        recoveryContext,
      })).toBe('AUTHENTICATION_PROVENANCE_INVALID');
    },
  );

  it.each(['absent', 'valid', 'invalid'] as const)(
    'rejects INVALID_CONTEXT with %s signed context even for exact password AMR',
    (recoveryContext) => {
      // INVALID_CONTEXT covers a malformed identity/session claim, an Auth user/session mismatch,
      // and a verified session_id with no live auth.sessions row. None may reach Admin.
      expect(classifyAdminAuthenticationProvenance({
        claims: CLAIMS,
        recoveryState: 'INVALID_CONTEXT',
        recoveryContext,
      })).toBe('AUTHENTICATION_PROVENANCE_INVALID');
    },
  );

  it.each(SUPPORTED_RECOVERY_METHODS)(
    'accepts the documented %s AMR only at the already-verified recovery entry point',
    (method) => {
      expect(hasRecoveryAcceptanceProvenance({
        ...CLAIMS,
        authenticationMethods: [method],
      })).toBe(true);
      // The same method still cannot reach ordinary Admin without a durable recovery row.
      expect(classifyAdminAuthenticationProvenance({
        claims: { ...CLAIMS, authenticationMethods: [method] },
        recoveryState: 'NOT_REGISTERED',
        recoveryContext: 'absent',
      })).toBe('AUTHENTICATION_PROVENANCE_INVALID');
    },
  );

  it.each(UNSUPPORTED_RECOVERY_METHOD_SET_CASES)(
    'refuses recovery-entry provenance for unsupported AMR %j',
    (authenticationMethods) => {
      expect(hasRecoveryAcceptanceProvenance({
        ...CLAIMS,
        authenticationMethods,
      })).toBe(false);
    },
  );

  it('never treats recovery-entry provenance as Admin password provenance', () => {
    for (const method of SUPPORTED_RECOVERY_METHODS) {
      expect(hasSupportedAdminPasswordProvenance({
        ...CLAIMS,
        authenticationMethods: [method],
      })).toBe(false);
    }
    // Admin entry remains exactly one `password` method and nothing else.
    expect(hasSupportedAdminPasswordProvenance(CLAIMS)).toBe(true);
    expect(hasSupportedAdminPasswordProvenance({
      ...CLAIMS,
      authenticationMethods: ['password', 'recovery'],
    })).toBe(false);
    expect(hasRecoveryAcceptanceProvenance(CLAIMS)).toBe(false);
  });
});
