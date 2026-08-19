import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  inspectContext: vi.fn(),
  getClaims: vi.fn(),
  rpc: vi.fn(),
  resolveAdmin: vi.fn(),
  adminFrom: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createAdminClient,
}));
vi.mock('./recoveryContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('./recoveryContext')>();
  return {
    ...original,
    inspectRecoveryContextForSession: mocks.inspectContext,
  };
});
vi.mock('./adminContext', () => ({
  resolveAdminContextFromAuthUser: mocks.resolveAdmin,
}));

import { requireAdmin } from './requireAdmin';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_CONTEXT = {
  authUserId: USER_ID,
  adminUserId: '33333333-3333-4333-8333-333333333333',
  email: 'synthetic@example.test',
  fullName: 'Synthetic Admin',
  roles: ['admin'],
  permissions: ['projects.read'],
};

function claims(authenticationMethods = ['password']) {
  return {
    data: {
      claims: {
        sub: USER_ID,
        session_id: SESSION_ID,
        amr: authenticationMethods.map((method) => ({ method, timestamp: 1_800_000_000 })),
      },
    },
    error: null,
  };
}

describe('Admin recovery-purpose session gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerClient.mockResolvedValue({
      auth: { getClaims: mocks.getClaims },
      rpc: mocks.rpc,
    });
    mocks.inspectContext.mockResolvedValue('absent');
    mocks.getClaims.mockResolvedValue(claims());
    mocks.rpc.mockResolvedValue({ data: { resultCode: 'NOT_REGISTERED' }, error: null });
    mocks.createAdminClient.mockReturnValue({ from: mocks.adminFrom });
    mocks.resolveAdmin.mockResolvedValue(ADMIN_CONTEXT);
  });

  it.each(['absent', 'valid', 'invalid'])(
    'blocks durable recovery state with %s context before any Admin lookup',
    async (status) => {
      mocks.inspectContext.mockResolvedValueOnce(status);
      mocks.rpc.mockResolvedValueOnce({
        data: { resultCode: 'RECOVERY_SESSION' },
        error: null,
      });
      await expect(requireAdmin()).rejects.toMatchObject({
        type: 'PASSWORD_RECOVERY_REQUIRED',
        message: 'Password recovery must be completed.',
      });
      expect(mocks.createAdminClient).not.toHaveBeenCalled();
      expect(mocks.resolveAdmin).not.toHaveBeenCalled();
    },
  );

  it.each(['absent', 'valid', 'invalid'])(
    'rejects an inactive Auth session with %s context before any Admin lookup',
    async (status) => {
      // A cryptographically valid password JWT whose session_id no longer maps to a live
      // auth.sessions row: the lookup reports INVALID_CONTEXT, never NOT_REGISTERED.
      mocks.inspectContext.mockResolvedValueOnce(status);
      mocks.rpc.mockResolvedValueOnce({
        data: { resultCode: 'INVALID_CONTEXT' },
        error: null,
      });
      await expect(requireAdmin()).rejects.toMatchObject({
        type: 'AUTHENTICATION_PROVENANCE_INVALID',
        message: 'Authentication cannot be used for administrative access.',
      });
      expect(mocks.createAdminClient).not.toHaveBeenCalled();
      expect(mocks.adminFrom).not.toHaveBeenCalled();
      expect(mocks.resolveAdmin).not.toHaveBeenCalled();
    },
  );

  it('never reaches profile or role resolution for an inactive password session', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { resultCode: 'INVALID_CONTEXT' }, error: null });
    await expect(requireAdmin()).rejects.toMatchObject({
      type: 'AUTHENTICATION_PROVENANCE_INVALID',
    });
    // Exact password AMR must not rescue an Auth session that no longer exists.
    expect(await mocks.getClaims.mock.results[0].value).toEqual(claims(['password']));
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    expect(mocks.resolveAdmin).not.toHaveBeenCalled();
  });

  it.each([
    { authenticationMethods: ['otp'] },
    { authenticationMethods: ['recovery'] },
    { authenticationMethods: ['invite'] },
    { authenticationMethods: ['magiclink'] },
    { authenticationMethods: [] },
    { authenticationMethods: ['unknown'] },
  ])(
    'rejects unsupported AMR $authenticationMethods when the durable row is absent',
    async ({ authenticationMethods }) => {
      mocks.getClaims.mockResolvedValueOnce(claims(authenticationMethods));
      await expect(requireAdmin()).rejects.toMatchObject({
        type: 'AUTHENTICATION_PROVENANCE_INVALID',
      });
      expect(mocks.createAdminClient).not.toHaveBeenCalled();
      expect(mocks.resolveAdmin).not.toHaveBeenCalled();
    },
  );

  it.each(['valid', 'invalid'])(
    'rejects contradictory %s context when the durable row is absent',
    async (status) => {
      mocks.inspectContext.mockResolvedValueOnce(status);
      await expect(requireAdmin()).rejects.toMatchObject({
        type: 'AUTHENTICATION_PROVENANCE_INVALID',
      });
      expect(mocks.createAdminClient).not.toHaveBeenCalled();
    },
  );

  it('fails closed on lookup errors before reading context or constructing the Admin client', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'private provider detail' },
    });
    await expect(requireAdmin()).rejects.toMatchObject({
      type: 'AUTHENTICATION_PROVENANCE_INVALID',
      message: 'Authentication cannot be used for administrative access.',
    });
    expect(mocks.inspectContext).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it('allows only the strict password path and preserves the required trust order', async () => {
    await expect(requireAdmin()).resolves.toEqual(ADMIN_CONTEXT);
    expect(mocks.getClaims).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith('get_current_password_recovery_session_state');
    expect(mocks.inspectContext).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(mocks.resolveAdmin).toHaveBeenCalledWith(USER_ID, expect.anything());

    const getClaimsOrder = mocks.getClaims.mock.invocationCallOrder[0];
    const lookupOrder = mocks.rpc.mock.invocationCallOrder[0];
    const contextOrder = mocks.inspectContext.mock.invocationCallOrder[0];
    const adminClientOrder = mocks.createAdminClient.mock.invocationCallOrder[0];
    const adminLookupOrder = mocks.resolveAdmin.mock.invocationCallOrder[0];
    expect(getClaimsOrder).toBeLessThan(lookupOrder);
    expect(lookupOrder).toBeLessThan(contextOrder);
    expect(contextOrder).toBeLessThan(adminClientOrder);
    expect(adminClientOrder).toBeLessThan(adminLookupOrder);
  });
});
