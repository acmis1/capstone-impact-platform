import { describe, expect, it } from 'vitest';
import {
  assertPublicationExecutionTarget,
  isProductionPublicationEnabledValue,
  isProductionPublicationExecutionAvailable,
  isStagingPublicationEnabledValue,
  isStagingPublicationExecutionAvailable,
  resolvePublicationExecutionTarget,
} from './publicationExecutionPolicy';

const STAGING_HOST = 'synthetic-pp1-staging.supabase.co';
const STAGING_URL = `https://${STAGING_HOST}`;
const ENABLED_STAGING = {
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_EXPECTED_SUPABASE_HOST: STAGING_HOST,
  CAPSTONE_STAGING_PUBLICATION_ENABLED: 'true',
};
const PRODUCTION_HOST = 'synthetic-pp1-production.supabase.co';
const PRODUCTION_URL = `https://${PRODUCTION_HOST}`;
const ENABLED_PRODUCTION = {
  CAPSTONE_RUNTIME_ENV: 'production',
  CAPSTONE_EXPECTED_SUPABASE_HOST: PRODUCTION_HOST,
  CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: 'true',
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

  it.each([undefined, null, '', 'false', 'TRUE', ' true ', '1'])(
    'requires the exact production publication enable value: %s',
    (value) => {
      expect(isProductionPublicationEnabledValue(value)).toBe(false);
    },
  );

  it('accepts the exact production publication enable value', () => {
    expect(isProductionPublicationEnabledValue('true')).toBe(true);
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

  it('allows production only with its distinct flag, identity, and exact target host', () => {
    expect(isProductionPublicationExecutionAvailable(PRODUCTION_URL, ENABLED_PRODUCTION)).toBe(true);
    expect(() => assertPublicationExecutionTarget({
      target: 'production',
      supabaseUrl: PRODUCTION_URL,
      env: ENABLED_PRODUCTION,
    })).not.toThrow();
  });

  it.each([
    ['missing production flag', { ...ENABLED_PRODUCTION, CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: undefined }],
    ['disabled production flag', { ...ENABLED_PRODUCTION, CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: 'false' }],
    ['case-variant production flag', { ...ENABLED_PRODUCTION, CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: 'TRUE' }],
    ['padded production flag', { ...ENABLED_PRODUCTION, CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: ' true ' }],
    ['staging flag substitution', { ...ENABLED_PRODUCTION, CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: undefined, CAPSTONE_STAGING_PUBLICATION_ENABLED: 'true' }],
    ['staging runtime substitution', { ...ENABLED_PRODUCTION, CAPSTONE_RUNTIME_ENV: 'staging' }],
    ['wrong expected host', { ...ENABLED_PRODUCTION, CAPSTONE_EXPECTED_SUPABASE_HOST: STAGING_HOST }],
  ])('denies production for %s', (_label, env) => {
    expect(isProductionPublicationExecutionAvailable(PRODUCTION_URL, env)).toBe(false);
  });

  it('never lets the production authority enable staging or the staging authority enable production', () => {
    expect(isStagingPublicationExecutionAvailable(PRODUCTION_URL, ENABLED_PRODUCTION)).toBe(false);
    expect(isProductionPublicationExecutionAvailable(STAGING_URL, ENABLED_STAGING)).toBe(false);
  });

  it.each([
    'http://synthetic-pp1-production.supabase.co',
    'https://localhost',
    'https://127.0.0.1',
    'https://user@synthetic-pp1-production.supabase.co',
    'https://user:password@synthetic-pp1-production.supabase.co',
    'https://synthetic-pp1-production.supabase.co:443',
    'https://synthetic-pp1-production.supabase.co/private',
    'https://synthetic-pp1-production.supabase.co?target=production',
    'https://synthetic-pp1-production.supabase.co#production',
    'not-a-url',
  ])('rejects a non-canonical production URL identity: %s', (supabaseUrl) => {
    expect(isProductionPublicationExecutionAvailable(supabaseUrl, ENABLED_PRODUCTION)).toBe(false);
    expect(resolvePublicationExecutionTarget(supabaseUrl, ENABLED_PRODUCTION)).toBeNull();
  });

  it('resolves only explicit eligible targets and never falls an unknown target through to production', () => {
    expect(resolvePublicationExecutionTarget('http://127.0.0.1:54321', {})).toBe('local');
    expect(resolvePublicationExecutionTarget(STAGING_URL, ENABLED_STAGING)).toBe('staging');
    expect(resolvePublicationExecutionTarget(PRODUCTION_URL, ENABLED_PRODUCTION)).toBe('production');
    expect(resolvePublicationExecutionTarget('https://unknown.example', ENABLED_PRODUCTION)).toBeNull();
    expect(() => assertPublicationExecutionTarget({
      target: 'unknown' as never,
      supabaseUrl: PRODUCTION_URL,
      env: ENABLED_PRODUCTION,
    })).toThrow('recognized execution target');
  });
});
