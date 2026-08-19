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

  function client(resultCode = 'RECOVERY_SESSION') {
    return {
      auth: {
        getClaims: vi.fn(async () => ({
          data: {
            claims: {
              sub: CLAIMS.userId,
              session_id: CLAIMS.sessionId,
              amr: [{ method: 'otp', timestamp: 1_800_000_000 }],
            },
          },
          error: null,
        })),
      },
      rpc: vi.fn(async () => ({ data: { resultCode }, error: null })),
    };
  }

  it('requires verified claims, durable recovery state, exact OTP provenance, and exact context binding', async () => {
    await expect(getVerifiedPasswordRecoveryAccess(client())).resolves.toEqual({
      userId: CLAIMS.userId,
      sessionId: CLAIMS.sessionId,
      authenticationMethods: ['otp'],
    });
  });

  it('rejects missing durable state and wrong-session context substitution', async () => {
    await expect(getVerifiedPasswordRecoveryAccess(client('NOT_REGISTERED'))).resolves.toBeNull();
    cookieMocks.value = signRecoveryContext(
      CLAIMS.userId,
      '33333333-3333-4333-8333-333333333333',
      { secret, nowSeconds: 1_800_000_000 },
    );
    await expect(getVerifiedPasswordRecoveryAccess(client())).resolves.toBeNull();
  });
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

  it('rejects malformed durable lookup context even for exact password AMR', () => {
    expect(classifyAdminAuthenticationProvenance({
      claims: CLAIMS,
      recoveryState: 'INVALID_CONTEXT',
      recoveryContext: 'absent',
    })).toBe('AUTHENTICATION_PROVENANCE_INVALID');
  });

  it('accepts the locally proven recovery AMR only at the already-verified recovery entry point', () => {
    expect(hasRecoveryAcceptanceProvenance({ ...CLAIMS, authenticationMethods: ['otp'] })).toBe(true);
    expect(hasRecoveryAcceptanceProvenance(CLAIMS)).toBe(false);
    expect(hasRecoveryAcceptanceProvenance({
      ...CLAIMS,
      authenticationMethods: ['otp', 'password'],
    })).toBe(false);
  });
});
