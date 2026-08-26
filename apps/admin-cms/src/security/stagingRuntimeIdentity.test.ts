import { describe, expect, it } from 'vitest';
import { isVerifiedStagingRuntime } from './stagingRuntimeIdentity';

const VALID = {
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-staging.supabase.co',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-staging.supabase.co',
};

describe('web staging runtime identity', () => {
  it('accepts an exact hosted HTTPS staging target', () => {
    expect(isVerifiedStagingRuntime(VALID)).toBe(true);
  });

  it.each([
    ['production runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: 'production' }],
    ['case-variant runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: 'Staging' }],
    ['whitespace-padded runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: ' staging ' }],
    ['missing runtime', { ...VALID, CAPSTONE_RUNTIME_ENV: undefined }],
    ['malformed URL', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' }],
    ['HTTP target', { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'http://synthetic-staging.supabase.co' }],
    [
      'localhost target',
      {
        ...VALID,
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'localhost',
        NEXT_PUBLIC_SUPABASE_URL: 'https://localhost',
      },
    ],
    ['missing expected host', { ...VALID, CAPSTONE_EXPECTED_SUPABASE_HOST: undefined }],
    [
      'hostname mismatch',
      { ...VALID, NEXT_PUBLIC_SUPABASE_URL: 'https://other-synthetic.supabase.co' },
    ],
  ])('rejects %s', (_label, env) => {
    expect(isVerifiedStagingRuntime(env)).toBe(false);
  });
});
