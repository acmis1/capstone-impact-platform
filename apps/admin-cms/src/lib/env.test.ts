import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyKey, getPublicEnv, getServerEnv } from './env';

const PUBLIC_URL = 'https://synthetic-staging.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_synthetic-browser-value';
const SECRET_KEY = 'sb_secret_synthetic-server-value';

function syntheticJwt(payload: unknown) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${header}.${encodedPayload}.synthetic-signature`;
}

function syntheticJwtWithPayloadSegment(payloadSegment: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  return `${header}.${payloadSegment}.synthetic-signature`;
}

const LEGACY_ANON_JWT = syntheticJwt({ role: 'anon' });
const LEGACY_SERVICE_ROLE_JWT = syntheticJwt({ role: 'service_role' });

describe('fail-closed Supabase environment credentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_SUPABASE_URL = PUBLIC_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  function expectSanitizedPublicFailure(privateValue: string) {
    let message = '';
    try {
      getPublicEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Staging Configuration Error/);
    expect(message).not.toContain(privateValue);
    expect(message).not.toContain('service_role');
  }

  function expectSanitizedServerFailure(privateValue: string) {
    let message = '';
    try {
      getServerEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Staging Configuration Error/);
    expect(message).not.toContain(privateValue);
    expect(message).not.toContain('anon');
  }

  it('accepts a modern publishable browser credential', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;

    const env = getPublicEnv();

    expect(env.supabasePublicKey).toBe(PUBLISHABLE_KEY);
    expect(env.publicKeyType).toBe('publishable');
  });

  it('accepts an exact anon legacy JWT browser credential', () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = LEGACY_ANON_JWT;

    const env = getPublicEnv();

    expect(env.supabasePublicKey).toBe(LEGACY_ANON_JWT);
    expect(env.publicKeyType).toBe('legacy_anon_jwt');
  });

  it('preserves modern publishable preference when both public credentials are safe', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = LEGACY_ANON_JWT;

    expect(getPublicEnv()).toMatchObject({
      supabasePublicKey: PUBLISHABLE_KEY,
      publicKeyType: 'publishable',
    });
  });

  it('fails with a sanitized error when no public credential is configured', () => {
    expectSanitizedPublicFailure('private-value-not-present');
  });

  it.each([
    ['modern secret in publishable variable', 'publishable', 'sb_secret_public-slot-private'],
    ['modern secret in anon variable', 'anon', 'sb_secret_anon-slot-private'],
    ['service_role JWT in publishable variable', 'publishable', LEGACY_SERVICE_ROLE_JWT],
    ['service_role JWT in anon variable', 'anon', LEGACY_SERVICE_ROLE_JWT],
    ['malformed JWT', 'publishable', 'only.two'],
    ['invalid base64url payload', 'publishable', syntheticJwtWithPayloadSegment('%%%private%%%')],
    [
      'non-canonical padded base64url payload',
      'publishable',
      syntheticJwtWithPayloadSegment(
        `${Buffer.from(JSON.stringify({ role: 'anon' }), 'utf8').toString('base64url')}=`,
      ),
    ],
    [
      'invalid UTF-8 payload',
      'publishable',
      syntheticJwtWithPayloadSegment(Buffer.from([0xff]).toString('base64url')),
    ],
    [
      'invalid JSON payload',
      'publishable',
      syntheticJwtWithPayloadSegment(Buffer.from('private-not-json', 'utf8').toString('base64url')),
    ],
    ['JWT without role', 'publishable', syntheticJwt({ private_claim: 'missing-role' })],
    ['JWT with unexpected role', 'publishable', syntheticJwt({ role: 'authenticated' })],
    ['non-object JWT payload', 'publishable', syntheticJwt(['anon'])],
    ['unknown credential', 'publishable', 'private-unknown-public-key'],
  ])('rejects %s', (_label, variable, credential) => {
    if (variable === 'publishable') {
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = credential;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = credential;
    }

    expectSanitizedPublicFailure(credential);
  });

  it('rejects a safe preferred public key when the secondary public variable is unsafe', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = LEGACY_SERVICE_ROLE_JWT;

    expectSanitizedPublicFailure(LEGACY_SERVICE_ROLE_JWT);
  });

  it('rejects an unsafe preferred public key even when the secondary public variable is safe', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = LEGACY_SERVICE_ROLE_JWT;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = LEGACY_ANON_JWT;

    expectSanitizedPublicFailure(LEGACY_SERVICE_ROLE_JWT);
  });

  it('accepts a modern secret server credential', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    process.env.SUPABASE_SECRET_KEY = SECRET_KEY;

    const env = getServerEnv();

    expect(env.supabaseDatabaseAdminKey).toBe(SECRET_KEY);
    expect(env.databaseAdminKeyType).toBe('secret');
    expect(env.databaseAdminKeyMode).toBe('secret_key_preferred');
  });

  it('accepts an exact service_role legacy JWT server credential', () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = LEGACY_ANON_JWT;
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SERVICE_ROLE_JWT;

    const env = getServerEnv();

    expect(env.supabaseDatabaseAdminKey).toBe(LEGACY_SERVICE_ROLE_JWT);
    expect(env.databaseAdminKeyType).toBe('legacy_service_role_jwt');
    expect(env.databaseAdminKeyMode).toBe('legacy_service_role_jwt_fallback');
  });

  it('accepts a Local Supabase-style legacy anon and service_role pair', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = LEGACY_ANON_JWT;
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SERVICE_ROLE_JWT;

    const env = getServerEnv();

    expect(env.supabasePublicKey).toBe(LEGACY_ANON_JWT);
    expect(env.supabaseDatabaseAdminKey).toBe(LEGACY_SERVICE_ROLE_JWT);
  });

  it('preserves modern secret preference over a valid legacy fallback', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    process.env.SUPABASE_SECRET_KEY = SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SERVICE_ROLE_JWT;

    expect(getServerEnv()).toMatchObject({
      supabaseDatabaseAdminKey: SECRET_KEY,
      databaseAdminKeyType: 'secret',
      databaseAdminKeyMode: 'secret_key_preferred',
    });
  });

  it('does not block a valid preferred secret because an unused server-only fallback is malformed', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    process.env.SUPABASE_SECRET_KEY = SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'private-unused-malformed-fallback';

    expect(getServerEnv().supabaseDatabaseAdminKey).toBe(SECRET_KEY);
  });

  it('fails with a sanitized error when no server credential is configured', () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;

    expectSanitizedServerFailure('private-value-not-present');
  });

  it.each([
    ['publishable key', 'sb_publishable_misplaced-admin-private'],
    ['anon JWT', LEGACY_ANON_JWT],
    ['malformed legacy JWT', 'only.two'],
    ['unknown credential', 'private-unknown-admin-key'],
  ])('rejects a selected server-admin %s', (_label, credential) => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_KEY;
    process.env.SUPABASE_SECRET_KEY = credential;
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SERVICE_ROLE_JWT;

    expectSanitizedServerFailure(credential);
  });

  it('falls back from an empty preferred server key to a valid legacy service_role JWT', () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = LEGACY_ANON_JWT;
    process.env.SUPABASE_SECRET_KEY = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SERVICE_ROLE_JWT;

    expect(getServerEnv().databaseAdminKeyMode).toBe('legacy_service_role_jwt_fallback');
  });

  it('returns only semantically valid classifications', () => {
    expect(classifyKey(PUBLISHABLE_KEY, false)).toBe('publishable');
    expect(classifyKey(SECRET_KEY, true)).toBe('secret');
    expect(classifyKey(LEGACY_ANON_JWT, false)).toBe('legacy_anon_jwt');
    expect(classifyKey(LEGACY_SERVICE_ROLE_JWT, true)).toBe('legacy_service_role_jwt');
    expect(classifyKey(LEGACY_SERVICE_ROLE_JWT, false)).toBe('unknown');
    expect(classifyKey(LEGACY_ANON_JWT, true)).toBe('unknown');
    expect(classifyKey('sb_publishable_', false)).toBe('unknown');
    expect(classifyKey('sb_secret_', true)).toBe('unknown');
    expect(classifyKey(undefined, true)).toBe('missing');
  });

  it('does not log raw credentials or decoded claims when validation fails', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const privateCredential = syntheticJwt({ role: 'service_role', private_claim: 'do-not-log' });
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = privateCredential;

    expectSanitizedPublicFailure(privateCredential);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
