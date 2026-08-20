import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  getClaims: vi.fn(),
  signOut: vi.fn(),
  registrationRpc: vi.fn(),
  issueContext: vi.fn(),
  createServerClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createAdminClient,
}));
vi.mock('../../../../auth/recoveryContext', () => ({
  issueRecoveryContextCookie: mocks.issueContext,
}));

import { GET } from './route';

const USER = { id: '11111111-1111-4111-8111-111111111111' };
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = { access_token: 'synthetic-session' };
const claimsFor = (methods: readonly string[]) => ({
  data: {
    claims: {
      sub: USER.id,
      session_id: SESSION_ID,
      amr: methods.map((method) => ({ method, timestamp: 1_800_000_000 })),
    },
  },
  error: null,
});
const CLAIMS = claimsFor(['otp']);

/** Documented recovery-entry AMRs: Local custom TokenHash proves `otp`; hosted PKCE emits `recovery`. */
const SUPPORTED_RECOVERY_METHODS = ['otp', 'recovery'] as const;

/** Documented non-recovery and mixed AMRs that must never establish a recovery session. */
const UNSUPPORTED_RECOVERY_METHOD_CASES: readonly [readonly string[]][] = ([
  [],
  ['password'],
  ['magiclink'],
  ['invite'],
  ['email/signup'],
  ['email_change'],
  ['oauth'],
  ['token_refresh'],
  ['unknown'],
  ['otp', 'password'],
  ['recovery', 'password'],
  ['otp', 'recovery'],
  ['magiclink', 'recovery'],
] as const).map((methods) => [methods]);

describe('PKCE password-recovery callback', () => {
  const originalRender = process.env.RENDER;
  const originalExternal = process.env.RENDER_EXTERNAL_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RENDER;
    delete process.env.RENDER_EXTERNAL_URL;
    mocks.exchangeCode.mockResolvedValue({ data: { user: USER, session: SESSION }, error: null });
    mocks.getClaims.mockResolvedValue(CLAIMS);
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.registrationRpc.mockResolvedValue({ data: { resultCode: 'REGISTERED' }, error: null });
    mocks.issueContext.mockResolvedValue(undefined);
    mocks.createServerClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: mocks.exchangeCode,
        getClaims: mocks.getClaims,
        signOut: mocks.signOut,
      },
    });
    mocks.createAdminClient.mockReturnValue({ rpc: mocks.registrationRpc });
  });

  afterEach(() => {
    if (originalRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = originalRender;
    if (originalExternal === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = originalExternal;
  });

  it('exchanges, verifies, registers, then creates an exact session-bound recovery context', async () => {
    const response = await GET(new NextRequest(
      'http://localhost:3000/auth/recovery/callback?code=synthetic-code_123',
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('http://localhost:3000/auth/reset-password');
    expect(mocks.exchangeCode).toHaveBeenCalledOnce();
    expect(mocks.exchangeCode).toHaveBeenCalledWith('synthetic-code_123');
    expect(mocks.getClaims).toHaveBeenCalledOnce();
    expect(mocks.registrationRpc).toHaveBeenCalledWith(
      'register_password_recovery_session',
      { p_session_id: SESSION_ID, p_auth_user_id: USER.id },
    );
    expect(mocks.issueContext).toHaveBeenCalledWith(USER.id, SESSION_ID);
    expect(mocks.exchangeCode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getClaims.mock.invocationCallOrder[0],
    );
    expect(mocks.getClaims.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.registrationRpc.mock.invocationCallOrder[0],
    );
    expect(mocks.registrationRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.issueContext.mock.invocationCallOrder[0],
    );
  });

  it.each(SUPPORTED_RECOVERY_METHODS)(
    'establishes a session-bound recovery context for the documented %s AMR',
    async (method) => {
      mocks.getClaims.mockResolvedValueOnce(claimsFor([method]));
      const response = await GET(new NextRequest(
        'http://localhost:3000/auth/recovery/callback?code=hosted-pkce_code-123',
      ));

      // Exactly: exchangeCodeForSession -> getClaims -> register -> issue context -> 303 reset.
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('http://localhost:3000/auth/reset-password');
      expect(mocks.exchangeCode).toHaveBeenCalledOnce();
      expect(mocks.exchangeCode).toHaveBeenCalledWith('hosted-pkce_code-123');
      expect(mocks.getClaims).toHaveBeenCalledOnce();
      expect(mocks.registrationRpc).toHaveBeenCalledOnce();
      expect(mocks.registrationRpc).toHaveBeenCalledWith(
        'register_password_recovery_session',
        { p_session_id: SESSION_ID, p_auth_user_id: USER.id },
      );
      expect(mocks.issueContext).toHaveBeenCalledOnce();
      // Identity comes only from the verified claims, never the exchange payload or URL.
      expect(mocks.issueContext).toHaveBeenCalledWith(USER.id, SESSION_ID);
      expect(mocks.exchangeCode.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.getClaims.mock.invocationCallOrder[0],
      );
      expect(mocks.getClaims.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.registrationRpc.mock.invocationCallOrder[0],
      );
      expect(mocks.registrationRpc.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.issueContext.mock.invocationCallOrder[0],
      );

      // A successful recovery entry must not terminate the session it just established.
      expect(mocks.signOut).not.toHaveBeenCalled();

      // No authorization code, session token, or provider detail reaches the client.
      const exposed = `${response.headers.get('Location') ?? ''}|${[...response.headers]
        .map(([key, value]) => `${key}=${value}`)
        .join('|')}|${await response.text()}`;
      expect(exposed).not.toContain('hosted-pkce_code-123');
      expect(exposed).not.toContain(SESSION.access_token);
      expect(exposed).not.toContain(method);
      expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    },
  );

  it.each(UNSUPPORTED_RECOVERY_METHOD_CASES)(
    'fails generically and cleans up for unsupported AMR %j',
    async (authenticationMethods) => {
      mocks.getClaims.mockResolvedValueOnce(claimsFor(authenticationMethods));
      const response = await GET(new NextRequest(
        'http://localhost:3000/auth/recovery/callback?code=valid-code',
      ));

      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe(
        'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
      );
      // Rejected before any durable registration or recovery context is created.
      expect(mocks.registrationRpc).not.toHaveBeenCalled();
      expect(mocks.issueContext).not.toHaveBeenCalled();
      // The unusable session is terminated rather than left live.
      expect(mocks.signOut).toHaveBeenCalledOnce();
      expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    },
  );

  it.each([
    '',
    '?code=',
    '?code=one&code=two',
    '?code=one&unknown=1',
    '?unknown=1',
    `?code=${'x'.repeat(2049)}`,
    '?code=contains%20space',
  ])('rejects malformed query %s before constructing a client', async (query) => {
    const response = await GET(new NextRequest(
      `http://localhost:3000/auth/recovery/callback${query}`,
    ));
    expect(response.headers.get('Location')).toBe(
      'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
    );
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it('fails generically for provider failure, missing user, or missing session', async () => {
    for (const result of [
      { data: { user: null, session: null }, error: { message: 'provider detail' } },
      { data: { user: USER, session: null }, error: null },
      { data: { user: null, session: SESSION }, error: null },
    ]) {
      mocks.exchangeCode.mockResolvedValueOnce(result);
      const response = await GET(new NextRequest(
        'http://localhost:3000/auth/recovery/callback?code=valid-code',
      ));
      expect(response.headers.get('Location')).toBe(
        'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
      );
    }
    expect(mocks.issueContext).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(3);
  });

  it('fails generically when verified claims or durable registration are invalid', async () => {
    mocks.getClaims.mockResolvedValueOnce({
      ...CLAIMS,
      data: { claims: { ...CLAIMS.data.claims, amr: [{ method: 'password', timestamp: 1 }] } },
    });
    const unsupported = await GET(new NextRequest(
      'http://localhost:3000/auth/recovery/callback?code=valid-code',
    ));
    expect(unsupported.headers.get('Location')).toBe(
      'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
    );

    mocks.registrationRpc.mockResolvedValueOnce({
      data: { resultCode: 'SESSION_USER_MISMATCH' },
      error: null,
    });
    const registrationFailure = await GET(new NextRequest(
      'http://localhost:3000/auth/recovery/callback?code=valid-code',
    ));
    expect(registrationFailure.headers.get('Location')).toBe(
      'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
    );
    expect(mocks.issueContext).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
  });

  it('does not expose provider detail when resolved sign-out cleanup fails', async () => {
    mocks.exchangeCode.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'private exchange detail' },
    });
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'private sign-out detail' } });
    const response = await GET(new NextRequest(
      'http://localhost:3000/auth/recovery/callback?code=valid-code',
    ));
    expect(response.headers.get('Location')).toBe(
      'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
    );
    expect(mocks.issueContext).not.toHaveBeenCalled();
  });

  it('uses the strict Render origin for success and failure and ignores forwarding headers', async () => {
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = 'https://public-staging.example';
    const headers = {
      host: 'evil.example',
      forwarded: 'host=evil.example;proto=https',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    };
    const success = await GET(new NextRequest(
      'http://localhost:10000/auth/recovery/callback?code=valid-code',
      { headers },
    ));
    const failure = await GET(new NextRequest(
      'http://localhost:10000/auth/recovery/callback?unknown=1',
      { headers },
    ));

    for (const response of [success, failure]) {
      expect(response.headers.get('Location')).toMatch(/^https:\/\/public-staging\.example\//);
      expect(response.headers.get('Location')).not.toContain('localhost:10000');
      expect(response.headers.get('Location')).not.toContain('evil.example');
      expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
    }
  });

  it('uses only the validated direct origin outside Render', async () => {
    const response = await GET(new NextRequest(
      'https://direct.example/auth/recovery/callback?code=valid-code',
      {
        headers: {
          host: 'evil.example',
          forwarded: 'host=evil.example;proto=http',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
        },
      },
    ));
    expect(response.headers.get('Location')).toBe(
      'https://direct.example/auth/reset-password',
    );
  });

  it('fails closed with security headers when the canonical origin is invalid', async () => {
    process.env.RENDER = 'true';
    process.env.RENDER_EXTERNAL_URL = 'https://public-staging.example/path';
    const response = await GET(new NextRequest(
      'http://localhost:10000/auth/recovery/callback?code=valid-code',
    ));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toBe('Password recovery could not be completed.');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });
});
