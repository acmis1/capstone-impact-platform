import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn((name: string, value: string) => values.set(name, value)),
    get: vi.fn((name: string) => {
      const value = values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.get, set: mocks.set }),
}));

import {
  RECOVERY_CONTEXT_COOKIE_NAME,
  RECOVERY_CONTEXT_MAX_AGE_SECONDS,
  clearRecoveryContextCookie,
  constantTimeSignatureMatches,
  getRecoveryContextCookieOptions,
  issueRecoveryContextCookie,
  signRecoveryContext,
  verifyRecoveryContext,
} from './recoveryContext';

const SECRET = 'synthetic-auth-flow-secret-32-bytes-minimum';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000;

function signPayload(payload: Record<string, unknown>): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(payloadPart).digest('base64url');
  return `${payloadPart}.${signature}`;
}

describe('signed password-recovery context', () => {
  const originalSecret = process.env.CAPSTONE_AUTH_FLOW_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.values.clear();
    process.env.CAPSTONE_AUTH_FLOW_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CAPSTONE_AUTH_FLOW_SECRET;
    else process.env.CAPSTONE_AUTH_FLOW_SECRET = originalSecret;
  });

  it('signs and verifies an exact, user-bound, short-lived payload', () => {
    const token = signRecoveryContext(USER_ID, {
      secret: SECRET,
      nowSeconds: NOW,
      nonce: 'abcdefghijklmnop',
    });
    const result = verifyRecoveryContext(token, {
      secret: SECRET,
      nowSeconds: NOW + 1,
      expectedUserId: USER_ID,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload).toEqual({
        version: 1,
        purpose: 'password_recovery',
        userId: USER_ID,
        issuedAt: NOW,
        expiresAt: NOW + RECOVERY_CONTEXT_MAX_AGE_SECONDS,
        nonce: 'abcdefghijklmnop',
      });
      expect(Object.keys(result.payload).sort()).toEqual([
        'expiresAt', 'issuedAt', 'nonce', 'purpose', 'userId', 'version',
      ]);
      expect(JSON.stringify(result.payload)).not.toMatch(/email|name|role/i);
    }
  });

  it('rejects tampered payloads and signatures', () => {
    const token = signRecoveryContext(USER_ID, { secret: SECRET, nowSeconds: NOW });
    const [payload, signature] = token.split('.');
    const tamperedPayload = `${payload[0] === 'A' ? 'B' : 'A'}${payload.slice(1)}`;
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    expect(verifyRecoveryContext(`${tamperedPayload}.${signature}`, { secret: SECRET, nowSeconds: NOW }).valid).toBe(false);
    expect(verifyRecoveryContext(`${payload}.${tamperedSignature}`, { secret: SECRET, nowSeconds: NOW }).valid).toBe(false);
  });

  it('rejects wrong purpose, user binding, expiry, future issue time, and excessive lifetime', () => {
    const validPayload = {
      version: 1,
      purpose: 'password_recovery',
      userId: USER_ID,
      issuedAt: NOW,
      expiresAt: NOW + 600,
      nonce: 'abcdefghijklmnop',
    };
    expect(verifyRecoveryContext(signPayload({ ...validPayload, purpose: 'invitation' }), { secret: SECRET, nowSeconds: NOW }).valid).toBe(false);
    expect(verifyRecoveryContext(signPayload(validPayload), { secret: SECRET, nowSeconds: NOW, expectedUserId: OTHER_USER_ID }).valid).toBe(false);
    expect(verifyRecoveryContext(signPayload(validPayload), { secret: SECRET, nowSeconds: NOW + 600 }).valid).toBe(false);
    expect(verifyRecoveryContext(signPayload({ ...validPayload, issuedAt: NOW + 31, expiresAt: NOW + 631 }), { secret: SECRET, nowSeconds: NOW }).valid).toBe(false);
    expect(verifyRecoveryContext(signPayload({ ...validPayload, expiresAt: NOW + 601 }), { secret: SECRET, nowSeconds: NOW }).valid).toBe(false);
  });

  it.each([
    '',
    'not-a-token',
    '%%%%.%%%%',
    'abc=.def=',
    'abc.def.extra',
  ])('rejects malformed base64url token %s', (token) => {
    expect(verifyRecoveryContext(token, { secret: SECRET, nowSeconds: NOW }).valid).toBe(false);
  });

  it('rejects missing and weak signing secrets without exposing their values', () => {
    delete process.env.CAPSTONE_AUTH_FLOW_SECRET;
    expect(() => signRecoveryContext(USER_ID, { nowSeconds: NOW })).toThrow(
      'Password recovery context configuration is unavailable.',
    );
    expect(() => signRecoveryContext(USER_ID, { secret: 'too-short', nowSeconds: NOW })).toThrow(
      'Password recovery context configuration is unavailable.',
    );
  });

  it('uses the constant-time comparison path for valid, malformed, and wrong-length signatures', () => {
    const signature = createHmac('sha256', SECRET).update('payload').digest('base64url');
    expect(constantTimeSignatureMatches(signature, signature)).toBe(true);
    expect(constantTimeSignatureMatches('bad', signature)).toBe(false);
    expect(constantTimeSignatureMatches('%%%%', signature)).toBe(false);
  });

  it('uses exact secure cookie options and clears with the same root path', async () => {
    expect(getRecoveryContextCookieOptions()).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 600,
    });

    await issueRecoveryContextCookie(USER_ID);
    expect(mocks.set).toHaveBeenLastCalledWith(
      RECOVERY_CONTEXT_COOKIE_NAME,
      expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 }),
    );

    await clearRecoveryContextCookie();
    expect(mocks.set).toHaveBeenLastCalledWith(
      RECOVERY_CONTEXT_COOKIE_NAME,
      '',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 }),
    );
  });

  it('sets Secure in production without changing the remaining cookie boundary', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    try {
      expect(getRecoveryContextCookieOptions()).toEqual({
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
        maxAge: 600,
      });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });
});
