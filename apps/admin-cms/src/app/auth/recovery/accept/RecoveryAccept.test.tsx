// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: 'synthetic-recovery-token' as string | undefined,
  cookieDelete: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  issueContext: vi.fn(),
  createServerClient: vi.fn(),
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
vi.mock('../../../../auth/recoveryContext', () => ({
  issueRecoveryContextCookie: mocks.issueContext,
}));

import AcceptRecoveryPage from './page';
import { acceptRecoveryAction } from './actions';

const USER = { id: '11111111-1111-4111-8111-111111111111' };
const SESSION = { access_token: 'synthetic-session' };

describe('recovery explicit acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.token = 'synthetic-recovery-token';
    mocks.verifyOtp.mockResolvedValue({ data: { user: USER, session: SESSION }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.issueContext.mockResolvedValue(undefined);
    mocks.createServerClient.mockResolvedValue({
      auth: { verifyOtp: mocks.verifyOtp, signOut: mocks.signOut },
    });
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

  it('consumes the cookie before one recovery verification and creates the signed context', async () => {
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
    expect(mocks.issueContext).toHaveBeenCalledWith(USER.id);
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
});
