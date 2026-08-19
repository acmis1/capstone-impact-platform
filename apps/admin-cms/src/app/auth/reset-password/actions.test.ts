import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyAccess: vi.fn(),
  clearContext: vi.fn(),
  createServerClient: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../auth/recoveryContext', () => ({
  clearRecoveryContextCookie: mocks.clearContext,
}));
vi.mock('../../../auth/recoverySession', () => ({
  getVerifiedPasswordRecoveryAccess: mocks.verifyAccess,
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

const ACCESS = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  authenticationMethods: ['otp'],
};

describe('dedicated recovery password update action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyAccess.mockResolvedValue(ACCESS);
    mocks.clearContext.mockResolvedValue(undefined);
    mocks.updateUser.mockResolvedValue({ data: { user: { id: ACCESS.userId } }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.createServerClient.mockResolvedValue({
      auth: {
        getClaims: vi.fn(),
        updateUser: mocks.updateUser,
        signOut: mocks.signOut,
      },
      rpc: vi.fn(),
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
    expect(mocks.verifyAccess).toHaveBeenCalledOnce();
    expect(mocks.updateUser).toHaveBeenCalledOnce();
    expect(mocks.updateUser).toHaveBeenCalledWith({ password });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.clearContext).toHaveBeenCalledOnce();
  });

  it('terminates generically when claims, durable state, or exact context binding is invalid', async () => {
    mocks.verifyAccess.mockResolvedValueOnce(null);
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).rejects.toThrow(
      'NEXT_REDIRECT:/auth/recovery/invalid',
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.clearContext).toHaveBeenCalledOnce();
  });

  it('preserves context and durable-state cleanup when invalid-access sign-out returns an error', async () => {
    mocks.verifyAccess.mockResolvedValueOnce(null);
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'private provider detail' } });
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).rejects.toThrow(
      'NEXT_REDIRECT:/auth/recovery/invalid',
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.clearContext).not.toHaveBeenCalled();
  });

  it('returns a bounded failure without clearing context when updateUser fails', async () => {
    mocks.updateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'private provider detail' },
    });
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).resolves.toEqual({
      error: 'PASSWORD_UPDATE_FAILED',
    });
    expect(mocks.updateUser).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clearContext).not.toHaveBeenCalled();
  });

  it('does not claim success or clear the gate when session termination resolves with an error', async () => {
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'private provider detail' } });
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).resolves.toEqual({
      error: 'SESSION_TERMINATION_FAILED',
    });
    expect(mocks.updateUser).toHaveBeenCalledOnce();
    expect(mocks.clearContext).not.toHaveBeenCalled();
  });

  it('does not claim success when post-termination context cleanup fails', async () => {
    mocks.clearContext.mockRejectedValueOnce(new Error('cookie write failed'));
    const password = 'ValidPassword1';
    await expect(resetPasswordAction({ password, confirmation: password })).resolves.toEqual({
      error: 'SESSION_TERMINATION_FAILED',
    });
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it('has no staff activation, Admin Auth mutation, or application repository dependency', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'actions.ts'), 'utf8');
    expect(source).not.toMatch(/completeStaffActivation|createSupabaseAdminClient/);
    expect(source).not.toMatch(/admin_users|user_roles|staff_provisioning_requests|invitations/);
    expect(source).toContain('updateUser');
    expect(source).toContain("signOut({ scope: 'local' })");
  });
});
