import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  parseCanonicalHttpOrigin,
  resolveCanonicalPublicOrigin,
  validateSameOrigin,
} from './csrf';

describe('canonical HTTP origin handling', () => {
  const renderOrigin = 'https://capstone-admin-cms-staging-v2.onrender.com';
  let originalRender: string | undefined;
  let originalRenderExternalUrl: string | undefined;

  beforeEach(() => {
    originalRender = process.env.RENDER;
    originalRenderExternalUrl = process.env.RENDER_EXTERNAL_URL;
    delete process.env.RENDER;
    delete process.env.RENDER_EXTERNAL_URL;
  });

  afterEach(() => {
    if (originalRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = originalRender;
    if (originalRenderExternalUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = originalRenderExternalUrl;
  });

  it('preserves exact direct HTTP and HTTPS origins', () => {
    expect(resolveCanonicalPublicOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveCanonicalPublicOrigin('https://preview.example:8443')).toBe('https://preview.example:8443');
  });

  it('keeps scheme and effective port exact for same-origin CSRF', () => {
    expect(validateSameOrigin('http://localhost:3000', 'http://localhost:3000')).toBe(true);
    expect(validateSameOrigin('https://localhost:3000', 'http://localhost:3000')).toBe(false);
    expect(validateSameOrigin('http://localhost:8080', 'http://localhost:3000')).toBe(false);
  });

  it('uses only the platform-owned external origin on Render', () => {
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = renderOrigin;

    expect(resolveCanonicalPublicOrigin('https://localhost:10000')).toBe(renderOrigin);
  });

  it('fails closed when the Render external origin is missing or malformed', () => {
    process.env.RENDER = 'true';
    expect(resolveCanonicalPublicOrigin('https://localhost:10000')).toBeNull();

    for (const value of [
      'not-a-url',
      'ftp://capstone-admin-cms-staging-v2.onrender.com',
      `${renderOrigin}/path`,
      `${renderOrigin}?query=1`,
      `${renderOrigin}#fragment`,
      'https://user@capstone-admin-cms-staging-v2.onrender.com',
    ]) {
      process.env.RENDER_EXTERNAL_URL = value;
      expect(resolveCanonicalPublicOrigin('https://localhost:10000')).toBeNull();
    }
  });

  it('rejects attacker prefix, suffix, and subdomain origins', () => {
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = renderOrigin;
    for (const value of [
      'https://evil-capstone-admin-cms-staging-v2.onrender.com',
      'https://capstone-admin-cms-staging-v2.onrender.com.evil.example',
      'https://sub.capstone-admin-cms-staging-v2.onrender.com',
    ]) {
      expect(parseCanonicalHttpOrigin(value)).not.toBe(renderOrigin);
      expect(validateSameOrigin(value, 'http://localhost:10000')).toBe(false);
    }
  });

  it('ignores Forwarded, X-Forwarded-Host, X-Forwarded-Proto, and Host', () => {
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = renderOrigin;
    const request = new NextRequest('http://localhost:10000/api/example', {
      headers: {
        forwarded: 'host=evil.example;proto=https',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        host: 'evil.example',
      },
    });

    expect(resolveCanonicalPublicOrigin(request.nextUrl.origin)).toBe(renderOrigin);
  });
});
