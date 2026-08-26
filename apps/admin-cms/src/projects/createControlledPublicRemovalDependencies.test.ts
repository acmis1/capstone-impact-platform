import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createControlledPublicRemovalDependencies } from './createControlledPublicRemovalDependencies';

const STAGING_HOST = 'synthetic-pp1-staging.supabase.co';
const STAGING_URL = `https://${STAGING_HOST}`;

function dependencies(executionTarget: 'local' | 'staging', supabaseUrl: string) {
  return createControlledPublicRemovalDependencies({
    supabase: {} as SupabaseClient,
    supabaseUrl,
    publicId: 'project_2026',
    adminId: '11111111-1111-4111-8111-111111111111',
    feedBucket: 'server-public-feeds',
    feedPath: 'capstones-latest.json',
    executionTarget,
  });
}

function enableStaging() {
  vi.stubEnv('CAPSTONE_RUNTIME_ENV', 'staging');
  vi.stubEnv('CAPSTONE_EXPECTED_SUPABASE_HOST', STAGING_HOST);
  vi.stubEnv('CAPSTONE_STAGING_PUBLICATION_ENABLED', 'true');
}

describe('controlled public removal dependency execution target', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('preserves the existing Local loopback assertion', () => {
    expect(() => dependencies('local', 'http://127.0.0.1:54321').assertExecutionEnvironment()).not.toThrow();
    expect(() => dependencies('local', STAGING_URL).assertExecutionEnvironment()).toThrow();
  });

  it('accepts only the exact enabled staging runtime and expected Supabase host', () => {
    enableStaging();
    expect(() => dependencies('staging', STAGING_URL).assertExecutionEnvironment()).not.toThrow();
  });

  it('rejects staging when the explicit publication gate is disabled', () => {
    enableStaging();
    vi.stubEnv('CAPSTONE_STAGING_PUBLICATION_ENABLED', 'false');
    expect(() => dependencies('staging', STAGING_URL).assertExecutionEnvironment()).toThrow();
  });

  it('rejects a wrong Supabase host and production runtime identity', () => {
    enableStaging();
    expect(() => dependencies('staging', 'https://production.supabase.co').assertExecutionEnvironment()).toThrow();
    vi.stubEnv('CAPSTONE_RUNTIME_ENV', 'production');
    expect(() => dependencies('staging', STAGING_URL).assertExecutionEnvironment()).toThrow();
  });
});
