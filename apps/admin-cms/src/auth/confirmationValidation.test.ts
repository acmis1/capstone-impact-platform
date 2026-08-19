import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  INVITATION_ACCEPT_PATH,
  INVITATION_COOKIE_NAME,
  INVITATION_COOKIE_PATH,
  INVITATION_PASSWORD_PATH,
  RECOVERY_ACCEPT_PATH,
  RECOVERY_PASSWORD_PATH,
  RECOVERY_TOKEN_COOKIE_NAME,
  RECOVERY_TOKEN_COOKIE_PATH,
  validateConfirmationNextPath,
  validateConfirmationParams,
} from './confirmationValidation';
import { GET } from '../app/auth/confirm/route';

describe('generic confirmation validation', () => {
  it('supports exactly invitation and recovery with fixed destinations', () => {
    expect(validateConfirmationParams({ tokenHash: 'invite-token', type: 'invite', next: INVITATION_PASSWORD_PATH }))
      .toEqual({ isValid: true, type: 'invite', next: INVITATION_PASSWORD_PATH });
    expect(validateConfirmationParams({ tokenHash: 'recovery-token', type: 'recovery', next: RECOVERY_PASSWORD_PATH }))
      .toEqual({ isValid: true, type: 'recovery', next: RECOVERY_PASSWORD_PATH });
    expect(validateConfirmationParams({ tokenHash: 'token', type: 'email', next: null }))
      .toEqual({ isValid: false, error: 'INVALID_TYPE' });
  });

  it('rejects cross-flow and attacker-selected destinations', () => {
    for (const next of [
      INVITATION_PASSWORD_PATH,
      '/admin',
      'https://evil.example/reset',
      '//evil.example/reset',
      '\\evil.example',
      '/auth/reset-password?next=/admin',
      '/auth/reset-password#fragment',
      '%2F%2Fevil.example',
    ]) {
      expect(validateConfirmationNextPath('recovery', next)).toBe(false);
    }
    expect(validateConfirmationNextPath('invite', RECOVERY_PASSWORD_PATH)).toBe(false);
  });

  it('rejects missing, blank, and oversized token hashes without returning them', () => {
    for (const tokenHash of [null, '', '   ', 'x'.repeat(2049)]) {
      const result = validateConfirmationParams({ tokenHash, type: 'recovery', next: RECOVERY_PASSWORD_PATH });
      expect(result.isValid).toBe(false);
      expect(JSON.stringify(result)).not.toContain('x'.repeat(64));
    }
  });
});

describe('confirmation capture route origin and cookie isolation', () => {
  const originalRender = process.env.RENDER;
  const originalExternal = process.env.RENDER_EXTERNAL_URL;

  beforeEach(() => {
    delete process.env.RENDER;
    delete process.env.RENDER_EXTERNAL_URL;
  });

  afterEach(() => {
    if (originalRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = originalRender;
    if (originalExternal === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = originalExternal;
  });

  it('captures recovery into only the dedicated cookie and clean acceptance URL', async () => {
    const response = await GET(new NextRequest(
      `http://localhost:3000/auth/confirm?token_hash=recovery-token&type=recovery&next=${encodeURIComponent(RECOVERY_PASSWORD_PATH)}`,
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`http://localhost:3000${RECOVERY_ACCEPT_PATH}`);
    expect(response.cookies.get(RECOVERY_TOKEN_COOKIE_NAME)).toMatchObject({
      value: 'recovery-token',
      httpOnly: true,
      sameSite: 'lax',
      path: RECOVERY_TOKEN_COOKIE_PATH,
      maxAge: 600,
    });
    expect(response.cookies.get(INVITATION_COOKIE_NAME)).toBeUndefined();
  });

  it('keeps invitation cookie name, path, and accept destination unchanged', async () => {
    const response = await GET(new NextRequest(
      `http://localhost:3000/auth/confirm?token_hash=invite-token&type=invite&next=${encodeURIComponent(INVITATION_PASSWORD_PATH)}`,
    ));
    expect(response.headers.get('Location')).toBe(`http://localhost:3000${INVITATION_ACCEPT_PATH}`);
    expect(response.cookies.get(INVITATION_COOKIE_NAME)).toMatchObject({
      value: 'invite-token',
      path: INVITATION_COOKIE_PATH,
    });
    expect(response.cookies.get(RECOVERY_TOKEN_COOKIE_NAME)).toBeUndefined();
  });

  it('uses the validated direct origin outside Render and ignores forwarding headers', async () => {
    const response = await GET(new NextRequest(
      'https://direct.example/auth/confirm?token_hash=recovery-token&type=recovery',
      {
        headers: {
          host: 'evil.example',
          forwarded: 'host=evil.example;proto=http',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
        },
      },
    ));
    expect(response.headers.get('Location')).toBe(`https://direct.example${RECOVERY_ACCEPT_PATH}`);
  });

  it('marks the recovery token cookie Secure in production', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    try {
      const response = await GET(new NextRequest(
        'http://localhost:3000/auth/confirm?token_hash=recovery-token&type=recovery',
      ));
      expect(response.cookies.get(RECOVERY_TOKEN_COOKIE_NAME)?.secure).toBe(true);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });

  it.each([
    'token_hash=token&type=recovery&type=recovery',
    'token_hash=token&token_hash=other&type=recovery',
    'token_hash=token&type=recovery&unknown=1',
    'type=recovery',
    `token_hash=${'x'.repeat(2049)}&type=recovery`,
    'token_hash=token&type=recovery&next=https%3A%2F%2Fevil.example',
    'token_hash=token&type=recovery&next=%2F%2Fevil.example',
    'token_hash=token&type=recovery&next=%252F%252Fevil.example',
  ])('rejects malformed recovery query %s generically and expires only its cookie', async (query) => {
    const response = await GET(new NextRequest(`http://localhost:3000/auth/confirm?${query}`));
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('http://localhost:3000/login?error=RECOVERY_LINK_INVALID');
    expect(response.cookies.get(RECOVERY_TOKEN_COOKIE_NAME)?.maxAge).toBe(0);
    expect(response.cookies.get(INVITATION_COOKIE_NAME)).toBeUndefined();
  });

  it('uses the strict Render external origin for invitation and recovery success and failure', async () => {
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = 'https://public-staging.example';
    const headers = {
      host: 'evil.example',
      forwarded: 'host=evil.example;proto=https',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    };
    const urls = [
      'http://localhost:10000/auth/confirm?token_hash=one&type=invite',
      'http://localhost:10000/auth/confirm?token_hash=two&type=recovery',
      'http://localhost:10000/auth/confirm?type=invite',
      'http://localhost:10000/auth/confirm?type=recovery',
    ];
    const responses = await Promise.all(urls.map((url) => GET(new NextRequest(url, { headers }))));
    for (const response of responses) {
      expect(response.headers.get('Location')).toMatch(/^https:\/\/public-staging\.example\//);
      expect(response.headers.get('Location')).not.toContain('localhost:10000');
      expect(response.headers.get('Location')).not.toContain('evil.example');
      expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
    }
  });

  it('fails closed with a bounded response when the canonical origin is invalid', async () => {
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = 'https://public-staging.example/path';
    const response = await GET(new NextRequest(
      'http://localhost:10000/auth/confirm?token_hash=token&type=recovery',
    ));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toBe('Authentication request could not be completed.');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});
