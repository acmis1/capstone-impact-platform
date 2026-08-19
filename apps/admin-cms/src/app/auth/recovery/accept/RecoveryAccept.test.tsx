// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: 'synthetic-recovery-token' as string | undefined,
  cookieDelete: vi.fn(),
  verifyOtp: vi.fn(),
  getClaims: vi.fn(),
  signOut: vi.fn(),
  registrationRpc: vi.fn(),
  issueContext: vi.fn(),
  createServerClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    has: () => mocks.token !== undefined,
    get: () => mocks.token === undefined
      ? undefined
      : { name: 'capstone_recovery_token_hash', value: mocks.token },
    delete: mocks.cookieDelete,
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));
vi.mock('../../../../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createAdminClient,
}));
vi.mock('../../../../auth/recoveryContext', () => ({
  issueRecoveryContextCookie: mocks.issueContext,
}));

import AcceptRecoveryPage from './page';
import { acceptRecoveryAction } from './actions';

const USER = { id: '11111111-1111-4111-8111-111111111111' };
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = { access_token: 'synthetic-session' };
const CLAIMS = {
  data: {
    claims: {
      sub: USER.id,
      session_id: SESSION_ID,
      amr: [{ method: 'otp', timestamp: 1_800_000_000 }],
    },
  },
  error: null,
};

describe('recovery explicit acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.token = 'synthetic-recovery-token';
    mocks.verifyOtp.mockResolvedValue({ data: { user: USER, session: SESSION }, error: null });
    mocks.getClaims.mockResolvedValue(CLAIMS);
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.registrationRpc.mockResolvedValue({ data: { resultCode: 'REGISTERED' }, error: null });
    mocks.issueContext.mockResolvedValue(undefined);
    mocks.createServerClient.mockResolvedValue({
      auth: {
        verifyOtp: mocks.verifyOtp,
        getClaims: mocks.getClaims,
        signOut: mocks.signOut,
      },
    });
    mocks.createAdminClient.mockReturnValue({ rpc: mocks.registrationRpc });
  });

  it('renders a generic native POST action without initializing or verifying Supabase', async () => {
    const view = await AcceptRecoveryPage();
    render(view);

    expect(screen.getByRole('heading', { name: 'Continue password reset' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Continue to reset password' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe('/login');
    const form = screen.getByRole('button', { name: 'Continue to reset password' }).closest('form');
    expect(form?.querySelectorAll('input')).toHaveLength(0);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('synthetic-recovery-token');
  });

  it('verifies, parses, registers, then creates the exact session-bound context', async () => {
    await expect(acceptRecoveryAction()).rejects.toThrow('NEXT_REDIRECT:/auth/reset-password');

    expect(mocks.cookieDelete).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).toHaveBeenCalledWith({
      name: 'capstone_recovery_token_hash',
      path: '/auth/recovery',
    });
    expect(mocks.verifyOtp).toHaveBeenCalledOnce();
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      type: 'recovery',
      token_hash: 'synthetic-recovery-token',
    });
    expect(mocks.getClaims).toHaveBeenCalledOnce();
    expect(mocks.registrationRpc).toHaveBeenCalledWith(
      'register_password_recovery_session',
      { p_session_id: SESSION_ID, p_auth_user_id: USER.id },
    );
    expect(mocks.issueContext).toHaveBeenCalledWith(USER.id, SESSION_ID);
    expect(mocks.verifyOtp.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getClaims.mock.invocationCallOrder[0],
    );
    expect(mocks.getClaims.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.registrationRpc.mock.invocationCallOrder[0],
    );
    expect(mocks.registrationRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.issueContext.mock.invocationCallOrder[0],
    );
  });

  it('fails generically before client construction when the token is absent or oversized', async () => {
    for (const token of [undefined, 'x'.repeat(2049)]) {
      mocks.token = token;
      await expect(acceptRecoveryAction()).rejects.toThrow(
        'NEXT_REDIRECT:/login?error=RECOVERY_LINK_INVALID',
      );
    }
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it('fails generically when verification fails or omits the session and never activates staff', async () => {
    for (const result of [
      { data: { user: null, session: null }, error: { message: 'provider detail' } },
      { data: { user: USER, session: null }, error: null },
    ]) {
      mocks.verifyOtp.mockResolvedValueOnce(result);
      await expect(acceptRecoveryAction()).rejects.toThrow(
        'NEXT_REDIRECT:/login?error=RECOVERY_LINK_INVALID',
      );
    }
    expect(mocks.issueContext).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
  });

  it('fails closed before context issuance for mismatched claims, unsupported AMR, or registration failure', async () => {
    mocks.getClaims
      .mockResolvedValueOnce({
        ...CLAIMS,
        data: { claims: { ...CLAIMS.data.claims, sub: '33333333-3333-4333-8333-333333333333' } },
      })
      .mockResolvedValueOnce({
        ...CLAIMS,
        data: { claims: { ...CLAIMS.data.claims, amr: [{ method: 'password', timestamp: 1 }] } },
      });
    mocks.registrationRpc.mockResolvedValueOnce({
      data: { resultCode: 'SESSION_NOT_FOUND' },
      error: null,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(acceptRecoveryAction()).rejects.toThrow(
        'NEXT_REDIRECT:/login?error=RECOVERY_LINK_INVALID',
      );
    }
    expect(mocks.issueContext).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(3);
  });

  it('does not clear durable state or expose detail when resolved sign-out cleanup fails', async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'private verification detail' },
    });
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'private sign-out detail' } });
    await expect(acceptRecoveryAction()).rejects.toThrow(
      'NEXT_REDIRECT:/login?error=RECOVERY_LINK_INVALID',
    );
    expect(mocks.issueContext).not.toHaveBeenCalled();
    expect(mocks.registrationRpc).not.toHaveBeenCalled();
  });
});
