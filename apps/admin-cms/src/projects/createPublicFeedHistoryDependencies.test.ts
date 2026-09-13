import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPublicFeedHistoryDependencies } from './createPublicFeedHistoryDependencies';

function dependencies(
  environment: Record<string, string | undefined>,
  executionTarget: 'local' | 'staging' | 'production' = 'production',
  supabaseUrl = 'https://synthetic-production.supabase.co',
) {
  return createPublicFeedHistoryDependencies({
    supabase: {} as SupabaseClient,
    supabaseUrl,
    adminId: '11111111-1111-4111-8111-111111111111',
    permissions: ['projects.publish'],
    feedBucket: 'public-feeds',
    feedPath: 'capstones-latest.json',
    executionTarget,
    environment,
  });
}

describe('public feed history production execution policy', () => {
  it('allows activation and forward recovery only for the exact enabled production identity', () => {
    expect(() => dependencies({
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-production.supabase.co',
      CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: 'true',
    }).assertActivationEnvironment()).not.toThrow();
  });

  it.each([
    ['missing production flag', {
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-production.supabase.co',
    }],
    ['staging flag substitution', {
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-production.supabase.co',
      CAPSTONE_STAGING_PUBLICATION_ENABLED: 'true',
    }],
    ['wrong host', {
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'different-production.supabase.co',
      CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: 'true',
    }],
  ])('fails closed for %s', (_label, environment) => {
    expect(() => dependencies(environment).assertActivationEnvironment()).toThrow('EXECUTION_POLICY_DENIED');
  });

  it('does not infer production when the named target is missing or contradictory', () => {
    const environment = {
      CAPSTONE_RUNTIME_ENV: 'production',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-production.supabase.co',
      CAPSTONE_PRODUCTION_PUBLICATION_ENABLED: 'true',
    };
    const missingTarget = createPublicFeedHistoryDependencies({
      supabase: {} as SupabaseClient,
      supabaseUrl: 'https://synthetic-production.supabase.co',
      adminId: '11111111-1111-4111-8111-111111111111',
      permissions: ['projects.publish'],
      feedBucket: 'public-feeds',
      feedPath: 'capstones-latest.json',
      environment,
    });
    expect(() => missingTarget.assertActivationEnvironment()).toThrow('EXECUTION_POLICY_DENIED');
    expect(() => dependencies(environment, 'staging').assertActivationEnvironment())
      .toThrow('EXECUTION_POLICY_DENIED');
  });

  it('preserves explicit Local and staging activation targets', () => {
    expect(() => dependencies({}, 'local', 'http://127.0.0.1:54321')
      .assertActivationEnvironment()).not.toThrow();
    expect(() => dependencies({
      CAPSTONE_RUNTIME_ENV: 'staging',
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-staging.supabase.co',
      CAPSTONE_STAGING_PUBLICATION_ENABLED: 'true',
    }, 'staging', 'https://synthetic-staging.supabase.co')
      .assertActivationEnvironment()).not.toThrow();
  });
});
