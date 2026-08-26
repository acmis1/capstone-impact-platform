import { describe, expect, it } from 'vitest';
import {
  assertPublicationExecutionTarget,
  isStagingPublicationEnabledValue,
  isStagingPublicationExecutionAvailable,
} from './publicationExecutionPolicy';

const STAGING_HOST = 'synthetic-pp1-staging.supabase.co';
const STAGING_URL = `https://${STAGING_HOST}`;
const ENABLED_STAGING = {
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_EXPECTED_SUPABASE_HOST: STAGING_HOST,
  CAPSTONE_STAGING_PUBLICATION_ENABLED: 'true',
};

describe('publication execution policy', () => {
  it.each([undefined, null, '', 'false', 'TRUE', ' true ', '1'])(
    'requires the exact staging publication enable value: %s',
    (value) => {
      expect(isStagingPublicationEnabledValue(value)).toBe(false);
    },
  );

  it('accepts the exact staging publication enable value', () => {
    expect(isStagingPublicationEnabledValue('true')).toBe(true);
  });

  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://[::1]:54321',
  ])('allows the existing disposable Local target: %s', (supabaseUrl) => {
    expect(() => assertPublicationExecutionTarget({ target: 'local', supabaseUrl })).not.toThrow();
  });

  it.each([
    STAGING_URL,
    'https://production.supabase.co',
    'https://arbitrary-remote.example.com',
  ])('keeps Local execution unavailable for remote target: %s', (supabaseUrl) => {
    expect(() => assertPublicationExecutionTarget({ target: 'local', supabaseUrl })).toThrow();
  });

  it('allows staging only when explicit enablement, staging identity, and exact target host all match', () => {
    expect(isStagingPublicationExecutionAvailable(STAGING_URL, ENABLED_STAGING)).toBe(true);
    expect(() => assertPublicationExecutionTarget({
      target: 'staging',
      supabaseUrl: STAGING_URL,
      env: ENABLED_STAGING,
    })).not.toThrow();
  });

  it.each([
    ['missing enablement', { ...ENABLED_STAGING, CAPSTONE_STAGING_PUBLICATION_ENABLED: undefined }],
    ['disabled enablement', { ...ENABLED_STAGING, CAPSTONE_STAGING_PUBLICATION_ENABLED: 'false' }],
    ['wrong runtime identity', { ...ENABLED_STAGING, CAPSTONE_RUNTIME_ENV: 'production' }],
    ['missing expected host', { ...ENABLED_STAGING, CAPSTONE_EXPECTED_SUPABASE_HOST: undefined }],
  ])('denies staging for %s', (_label, env) => {
    expect(isStagingPublicationExecutionAvailable(STAGING_URL, env)).toBe(false);
  });

  it('rejects a production target even when the staging publication flag is enabled', () => {
    expect(isStagingPublicationExecutionAvailable(
      'https://production.supabase.co',
      ENABLED_STAGING,
    )).toBe(false);
  });

  it('rejects an arbitrary remote target even when staging identity and enablement are present', () => {
    expect(isStagingPublicationExecutionAvailable(
      'https://arbitrary-remote.example.com',
      ENABLED_STAGING,
    )).toBe(false);
  });

  it.each([
    'http://synthetic-pp1-staging.supabase.co',
    'https://localhost',
    'not-a-url',
  ])('rejects an insecure, loopback, or malformed staging target: %s', (supabaseUrl) => {
    expect(isStagingPublicationExecutionAvailable(supabaseUrl, ENABLED_STAGING)).toBe(false);
  });
});
