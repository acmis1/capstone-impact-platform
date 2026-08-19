import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readContext: vi.fn(),
  verifyContext: vi.fn(),
  clearContext: vi.fn(),
  createServerClient: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../auth/recoveryContext', () => ({
  readRecoveryContextCookie: mocks.readContext,
  verifyRecoveryContext: mocks.verifyContext,
  clearRecoveryContextCookie: mocks.clearContext,
}));
vi.mock('../../../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((pathValue: string) => {
    throw new Error(`NEXT_REDIRECT:${pathValue}`);
  }),
}));

import { resetPasswordAction } from './actions';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_CONTEXT = {
  valid: true as const,
  payload: {
    version: 1,
    purpose: 'password_recovery',
    userId: USER_ID,
    issuedAt: 1,
    expiresAt: 601,
    nonce: 'abcdefghijklmnop',
  },
};

describe('dedicated recovery password update action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readContext.mockResolvedValue('signed-context');
    mocks.verifyContext.mockReturnValue(VALID_CONTEXT);
    mocks.clearContext.mockResolvedValue(undefined);
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    mocks.updateUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.createServerClient.mockResolvedValue({
      auth: {
        getUser: mocks.getUser,
        updateUser: mocks.updateUser,
        signOut: mocks.signOut,
      },
    });
  });

  it.each([
    [{}, 'PASSWORD_EMPTY'],
    [{ password: 'short', confirmation: 'short' }, 'PASSWORD_TOO_SHORT'],
    [{ password: 'a'.repeat(129), confirmation: 'a'.repeat(129) }, 'PASSWORD_TOO_LONG'],
    [{ password: 'a'.repeat(12), confirmation: 'b'.repeat(12) }, 'CONFIRMATION_MISMATCH'],
    [new FormData(), 'PASSWORD_EMPTY'],
  ])('validates plain input before creating clients: %o', async (input, error) => {
    await expect(resetPasswordAction(input as never)).resolves.toEqual({ error });
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it.each([12, 128])('updates a password at the %i-character boundary exactly once', async (length) => {
    const password = `A${'x'.repeat(length - 2)}1`;
    await expect(resetPasswordAction({ password, confirmation: password })).rejects.toThrow(
      'NEXT_REDIRECT:/login?status=PASSWORD_RESET',
    );
    expect(mocks.getUser).toHaveBeenCalledOnce();
    expect(mocks.updateUser).toHaveBeenCalledOnce();
    expect(mocks.updateUser).toHaveBeenCalledWith({ password });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.clearContext).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing context', null, { valid: false }],
    ['invalid signature', 'tampered-context', { valid: false }],
    ['expired context', 'expired-context', { valid: false }],
  ])('terminates generically for %s', async (_label, token, verification) => {
    mocks.readContext.mockResolvedValueOnce(token);
    mocks.verifyContext.mockReturnValueOnce(verification);
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).rejects.toThrow(
      'NEXT_REDIRECT:/auth/recovery/invalid',
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.clearContext).toHaveBeenCalledOnce();
  });

  it('rejects an unauthenticated or mismatched user before update', async () => {
    for (const getUserResult of [
      { data: { user: null }, error: { message: 'provider detail' } },
      { data: { user: { id: '22222222-2222-4222-8222-222222222222' } }, error: null },
    ]) {
      mocks.getUser.mockResolvedValueOnce(getUserResult);
      const password = 'ValidPassword1';
      await expect(resetPasswordAction({ password, confirmation: password })).rejects.toThrow(
        'NEXT_REDIRECT:/auth/recovery/invalid',
      );
    }
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
    expect(mocks.clearContext).toHaveBeenCalledTimes(2);
  });

  it('returns a bounded failure without clearing context when updateUser fails', async () => {
    mocks.updateUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'provider detail' } });
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).resolves.toEqual({
      error: 'PASSWORD_UPDATE_FAILED',
    });
    expect(mocks.updateUser).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clearContext).not.toHaveBeenCalled();
  });

  it('does not claim success or clear the gate when session termination fails', async () => {
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'provider detail' } });
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).resolves.toEqual({
      error: 'SESSION_TERMINATION_FAILED',
    });
    expect(mocks.updateUser).toHaveBeenCalledOnce();
    expect(mocks.clearContext).not.toHaveBeenCalled();
  });

  it('has no staff activation, Admin client, or application repository dependency', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'actions.ts'), 'utf8');
    expect(source).not.toMatch(/completeStaffActivation|createSupabaseAdminClient/);
    expect(source).not.toMatch(/admin_users|user_roles|staff_provisioning_requests|invitations/);
    expect(source).toContain('updateUser');
    expect(source).toContain("signOut({ scope: 'local' })");
  });
});
