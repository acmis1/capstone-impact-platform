import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClaims: vi.fn(),
  signOut: vi.fn(),
  registrationRpc: vi.fn(),
  issueContext: vi.fn(),
  clearContext: vi.fn(),
  createServerClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createAdminClient,
}));
vi.mock('../../auth/recoveryContext', () => ({
  issueRecoveryContextCookie: mocks.issueContext,
  clearRecoveryContextCookie: mocks.clearContext,
}));

import { finalizeImplicitRecoveryAction } from './recoveryActions';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const RECOVERY_CLAIMS = {
  data: {
    claims: {
      sub: USER_ID,
      session_id: SESSION_ID,
      amr: [{ method: 'recovery', timestamp: 1_800_000_000 }],
    },
  },
  error: null,
};

describe('finalizeImplicitRecoveryAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClaims.mockResolvedValue(RECOVERY_CLAIMS);
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.registrationRpc.mockResolvedValue({
      data: { resultCode: 'REGISTERED' },
      error: null,
    });
    mocks.issueContext.mockResolvedValue(undefined);
    mocks.clearContext.mockResolvedValue(undefined);
    mocks.createServerClient.mockResolvedValue({
      auth: {
        getClaims: mocks.getClaims,
        signOut: mocks.signOut,
      },
    });
    mocks.createAdminClient.mockReturnValue({ rpc: mocks.registrationRpc });
  });

  it('registers only verified recovery provenance and issues session-bound reset context', async () => {
    await expect(finalizeImplicitRecoveryAction()).resolves.toEqual({ ok: true });

    expect(mocks.getClaims).toHaveBeenCalledOnce();
    expect(mocks.registrationRpc).toHaveBeenCalledWith(
      'register_password_recovery_session',
      { p_session_id: SESSION_ID, p_auth_user_id: USER_ID },
    );
    expect(mocks.issueContext).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('rejects ordinary password provenance and terminates the local session', async () => {
    mocks.getClaims.mockResolvedValueOnce({
      ...RECOVERY_CLAIMS,
      data: {
        claims: {
          ...RECOVERY_CLAIMS.data.claims,
          amr: [{ method: 'password', timestamp: 1_800_000_000 }],
        },
      },
    });

    await expect(finalizeImplicitRecoveryAction()).resolves.toEqual({ ok: false });

    expect(mocks.registrationRpc).not.toHaveBeenCalled();
    expect(mocks.issueContext).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.clearContext).toHaveBeenCalledOnce();
  });

  it('fails closed when durable recovery registration is not accepted', async () => {
    mocks.registrationRpc.mockResolvedValueOnce({
      data: { resultCode: 'SESSION_NOT_FOUND' },
      error: null,
    });

    await expect(finalizeImplicitRecoveryAction()).resolves.toEqual({ ok: false });

    expect(mocks.issueContext).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.clearContext).toHaveBeenCalledOnce();
  });

  it('does not claim success when context issuance fails and attempts cleanup', async () => {
    mocks.issueContext.mockRejectedValueOnce(new Error('synthetic context failure'));

    await expect(finalizeImplicitRecoveryAction()).resolves.toEqual({ ok: false });

    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.clearContext).toHaveBeenCalledOnce();
  });

  it('remains failed closed when sign-out cleanup also fails', async () => {
    mocks.getClaims.mockRejectedValueOnce(new Error('synthetic claims failure'));
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'synthetic sign-out failure' } });

    await expect(finalizeImplicitRecoveryAction()).resolves.toEqual({ ok: false });

    expect(mocks.clearContext).not.toHaveBeenCalled();
  });
});
