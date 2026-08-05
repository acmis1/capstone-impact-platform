import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getServerEnv, getPublicEnv, classifyKey } from './env';

describe('Modern Server-Key Preference & Environment Selection Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('1. Secret key only: selects SUPABASE_SECRET_KEY with secret_key_preferred mode', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_testkey123';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_serverkey123';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const env = getServerEnv();

    expect(env.supabaseDatabaseAdminKey).toBe('sb_secret_serverkey123');
    expect(env.databaseAdminKeyType).toBe('secret');
    expect(env.databaseAdminKeyMode).toBe('secret_key_preferred');
  });

  it('2. Legacy service-role key only: selects legacy key with legacy_service_role_jwt_fallback mode', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_testkey123';
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testjwt';

    const env = getServerEnv();

    expect(env.supabaseDatabaseAdminKey).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testjwt');
    expect(env.databaseAdminKeyType).toBe('legacy_service_role_jwt');
    expect(env.databaseAdminKeyMode).toBe('legacy_service_role_jwt_fallback');
  });

  it('3. Both keys present: prefers SUPABASE_SECRET_KEY over legacy service_role key', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_testkey123';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_serverkey123';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testjwt';

    const env = getServerEnv();

    expect(env.supabaseDatabaseAdminKey).toBe('sb_secret_serverkey123');
    expect(env.databaseAdminKeyType).toBe('secret');
    expect(env.databaseAdminKeyMode).toBe('secret_key_preferred');
  });

  it('4. Neither key present: fails with sanitized configuration error containing zero secret values', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_testkey123';
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => getServerEnv()).toThrowError(/Staging Configuration Error: Required server variables are missing/);
    try {
      getServerEnv();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain('sb_secret_');
      expect(msg).not.toContain('eyJhbGci');
    }
  });

  it('5. Browser publishable preference unchanged: prefers publishable key over legacy anon key', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_browserkey123';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anonjwt';

    const pub = getPublicEnv();

    expect(pub.supabasePublicKey).toBe('sb_publishable_browserkey123');
    expect(pub.publicKeyType).toBe('publishable');
  });

  it('6. classifyKey correctly classifies key types safely without exposing raw secrets', () => {
    expect(classifyKey('sb_publishable_abc', false)).toBe('publishable');
    expect(classifyKey('sb_secret_xyz', true)).toBe('secret');
    expect(classifyKey('eyJhbGci', false)).toBe('legacy_anon_jwt');
    expect(classifyKey('eyJhbGci', true)).toBe('legacy_service_role_jwt');
    expect(classifyKey(undefined, true)).toBe('missing');
    expect(classifyKey('custom_key', true)).toBe('unknown');
  });

  it('7. Empty string SUPABASE_SECRET_KEY falls back safely to SUPABASE_SERVICE_ROLE_KEY', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anonjwt';
    process.env.SUPABASE_SECRET_KEY = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.servicejwt';

    const env = getServerEnv();

    expect(env.supabaseDatabaseAdminKey).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.servicejwt');
    expect(env.databaseAdminKeyMode).toBe('legacy_service_role_jwt_fallback');
  });
});
