import { describe, expect, it } from 'vitest';
import { isLocalPublicationExecutionAvailable, isLocalPublicFeedRollbackAvailable } from './localPublicationExecution';

describe('isLocalPublicationExecutionAvailable', () => {
  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://[::1]:54321',
  ])('accepts canonical loopback Supabase endpoints: %s', (url) => {
    expect(isLocalPublicationExecutionAvailable(url)).toBe(true);
  });

  it.each([
    'https://example.supabase.co',
    'http://192.168.1.10:54321',
    'not-a-url',
  ])('fails closed for non-loopback or invalid endpoints: %s', (url) => {
    expect(isLocalPublicationExecutionAvailable(url)).toBe(false);
  });
});

describe('isLocalPublicFeedRollbackAvailable', () => {
  it('requires loopback, explicit local identity, and an explicit rollback capability', () => {
    expect(isLocalPublicFeedRollbackAvailable('http://127.0.0.1:54321', {
      CAPSTONE_RUNTIME_ENV: 'local', CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
    })).toBe(true);
  });

  it.each([
    ['https://staging.supabase.co', { CAPSTONE_RUNTIME_ENV: 'local', CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true' }],
    ['http://127.0.0.1:54321', { CAPSTONE_RUNTIME_ENV: 'staging', CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true' }],
    ['http://127.0.0.1:54321', { CAPSTONE_RUNTIME_ENV: 'local' }],
  ])('fails closed for %s with incomplete identity evidence', (url, env) => {
    expect(isLocalPublicFeedRollbackAvailable(url, env)).toBe(false);
  });
});
