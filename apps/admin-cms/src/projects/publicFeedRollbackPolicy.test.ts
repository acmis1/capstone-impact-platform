import { describe, expect, it } from 'vitest';
import {
  assertPublicFeedRollbackEnvironmentAvailable,
  isPublicFeedRollbackEnvironmentAvailable,
} from './publicFeedRollbackPolicy';

const STAGING_HOST = 'synthetic-pp1-staging.supabase.co';
const STAGING_URL = `https://${STAGING_HOST}`;
const VERIFIED_STAGING = {
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_EXPECTED_SUPABASE_HOST: STAGING_HOST,
  CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
};

describe('public feed rollback environment capability', () => {
  it('preserves explicitly enabled disposable Local rollback', () => {
    expect(assertPublicFeedRollbackEnvironmentAvailable('http://127.0.0.1:54321', {
      CAPSTONE_RUNTIME_ENV: 'local',
      CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
    })).toBe('local');
  });

  it('allows only the canonical verified staging identity with the dedicated exact flag', () => {
    expect(assertPublicFeedRollbackEnvironmentAvailable(STAGING_URL, VERIFIED_STAGING))
      .toBe('staging');
  });

  it.each([undefined, '', 'false', 'TRUE', ' true ', '1'])(
    'keeps verified staging disabled for flag value %s',
    (value) => {
      expect(isPublicFeedRollbackEnvironmentAvailable(STAGING_URL, {
        ...VERIFIED_STAGING,
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: value,
      })).toBe(false);
    },
  );

  it.each([
    ['wrong environment', { ...VERIFIED_STAGING, CAPSTONE_RUNTIME_ENV: 'local' }],
    ['unknown environment', { ...VERIFIED_STAGING, CAPSTONE_RUNTIME_ENV: 'preview' }],
    ['wrong expected host', { ...VERIFIED_STAGING, CAPSTONE_EXPECTED_SUPABASE_HOST: 'other.supabase.co' }],
    ['missing expected host', { ...VERIFIED_STAGING, CAPSTONE_EXPECTED_SUPABASE_HOST: undefined }],
  ])('denies staging for %s', (_label, env) => {
    expect(isPublicFeedRollbackEnvironmentAvailable(STAGING_URL, env)).toBe(false);
  });

  it('denies production even when every rollback flag is enabled', () => {
    expect(isPublicFeedRollbackEnvironmentAvailable('https://production.supabase.co', {
      ...VERIFIED_STAGING,
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'production.supabase.co',
      CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
    })).toBe(false);
  });

  it.each([
    'http://synthetic-pp1-staging.supabase.co',
    'https://localhost',
    'https://127.0.0.1',
    'not-a-url',
  ])('denies an insecure, loopback, or malformed hosted target: %s', (url) => {
    expect(isPublicFeedRollbackEnvironmentAvailable(url, VERIFIED_STAGING)).toBe(false);
  });
});
