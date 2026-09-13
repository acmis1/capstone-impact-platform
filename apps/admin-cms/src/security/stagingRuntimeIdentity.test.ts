import { describe, expect, it } from 'vitest';
import {
  isProductionRuntimeEnvironment,
  isStagingRuntimeEnvironment,
  isVerifiedProductionRuntime,
  isVerifiedStagingRuntime,
} from './stagingRuntimeIdentity';

const VALID = {
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-staging.supabase.co',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co',
};

describe('web staging runtime identity', () => {
  it('accepts an exact hosted HTTPS staging target', () => {
    expect(isVerifiedStagingRuntime(VALID)).toBe(true);
    expect(isVerifiedStagingRuntime({ ...VALID, NEXT_PUBLIC_SUPABASE_URL: `${VALID.NEXT_PUBLIC_SUPABASE_URL}/` })).toBe(true);
    expect(isStagingRuntimeEnvironment(VALID)).toBe(true);
  });

  it.each([
    ['production runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: 'production' }],
    ['case-variant runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: 'Staging' }],
    ['whitespace-padded runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: ' staging ' }],
    ['missing runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: undefined }],
    ['malformed URL', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' }],
    ['HTTP target', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'http://synthetic-staging.supabase.co' }],
    ['whitespace-padded URL', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: ' https://synthetic-staging.supabase.co ' }],
    ['explicit default port', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co:443/' }],
    ['explicit port', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co:4443/' }],
    ['alternate base path', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co/alternate' }],
    ['query string', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co?x=1' }],
    ['fragment', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co#x' }],
    ['username', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://user@synthetic-staging.supabase.co' }],
    ['password', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://user:password@synthetic-staging.supabase.co' }],
    ['hostname lookalike', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co.attacker.example' }],
    [
      'trailing-dot hostname',
      {
        ...VALID,
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-staging.supabase.co.',
        NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co.',
      },
    ],
    [
      'localhost target',
      {
        ...VALID,
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'localhost',
        NEXT_PUBLIC_SUPABASE_URL: 'https://localhost',
      },
    ],
    ['missing expected host', { ...VALID, CAPSTONE_EXPECTED_SUPABASE_HOST: undefined }],
    ['whitespace-padded expected host', { ...VALID, CAPSTONE_EXPECTED_SUPABASE_HOST: ' synthetic-staging.supabase.co ' }],
    [
      'hostname mismatch',
      { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://other-synthetic.supabase.co' },
    ],
  ])('rejects %s', (_label, env) => {
    expect(isVerifiedStagingRuntime(env)).toBe(false);
  });

  it.each([
    'localhost',
    'localhost.',
    '127.0.0.1',
    '127.1.2.3',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[::ffff:127.0.0.1]',
    '[0:0:0:0:0:ffff:7f00:1]',
  ])('rejects loopback host form %s', (host) => {
    expect(isVerifiedStagingRuntime({
      ...VALID,
      CAPSTONE_EXPECTED_SUPABASE_HOST: host,
      NEXT_PUBLIC_SUPABASE_URL: `https://${host}`,
    })).toBe(false);
  });

  it('accepts only an exact production identity for the production target', () => {
    const production = {
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-production.supabase.co',
      NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-production.supabase.co',
    };
    expect(isProductionRuntimeEnvironment(production)).toBe(true);
    expect(isVerifiedProductionRuntime(production)).toBe(true);
    expect(isVerifiedStagingRuntime(production)).toBe(false);
    expect(isVerifiedProductionRuntime({ ...production, CAPSTONE_RUNTIME_ENV: 'Production' })).toBe(false);
    expect(isVerifiedProductionRuntime({ ...production, NEXT_PUBLIC_SUPABASE_URL: VALID.NEXT_PUBLIC_SUPABASE_URL })).toBe(false);
  });

  it.each([
    ['missing runtime', { CAPSTONE_RUNTIME_ENV: undefined }],
    ['unknown runtime', { CAPSTONE_RUNTIME_ENV: 'live' }],
    ['missing host', { CAPSTONE_EXPECTED_SUPABASE_HOST: undefined }],
    ['padded host', { CAPSTONE_EXPECTED_SUPABASE_HOST: ' synthetic-production.supabase.co ' }],
    ['host mismatch', { NEXT_PUBLIC_SUPABASE_URL: 'https://different-production.supabase.co' }],
    ['loopback host', {
      CAPSTONE_EXPECTED_SUPABASE_HOST: '127.0.0.1',
      NEXT_PUBLIC_SUPABASE_URL: 'https://127.0.0.1',
    }],
    ['credential-bearing URL', {
      NEXT_PUBLIC_SUPABASE_URL: 'https://user:password@synthetic-production.supabase.co',
    }],
    ['non-canonical URL', {
      NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-production.supabase.co/private?mode=production',
    }],
  ])('fails closed for production identity with %s', (_label, override) => {
    expect(isVerifiedProductionRuntime({
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-production.supabase.co',
      NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-production.supabase.co',
      ...override,
    })).toBe(false);
  });
});
