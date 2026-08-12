import { describe, expect, it } from 'vitest';
import { isLocalPublicationExecutionAvailable } from './localPublicationExecution';

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
