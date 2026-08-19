import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  inspectContext: vi.fn(),
  getClaims: vi.fn(),
  resolveAdmin: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createAdminClient,
}));
vi.mock('./recoveryContext', () => ({
  inspectRecoveryContextForClient: mocks.inspectContext,
}));
vi.mock('./adminContext', () => ({
  resolveAdminContextFromAuthUser: mocks.resolveAdmin,
}));

import { requireAdmin } from './requireAdmin';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_CONTEXT = {
  authUserId: USER_ID,
  adminUserId: '22222222-2222-4222-8222-222222222222',
  email: 'synthetic@example.test',
  fullName: 'Synthetic Admin',
  roles: ['admin'],
  permissions: ['projects.read'],
};

describe('Admin recovery-purpose session gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerClient.mockResolvedValue({ auth: { getClaims: mocks.getClaims } });
    mocks.inspectContext.mockResolvedValue('absent');
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID } }, error: null });
    mocks.createAdminClient.mockReturnValue({ from: vi.fn() });
    mocks.resolveAdmin.mockResolvedValue(ADMIN_CONTEXT);
  });

  it.each(['valid', 'invalid'])('blocks %s recovery context before claims or Admin lookup', async (status) => {
    mocks.inspectContext.mockResolvedValueOnce(status);
    await expect(requireAdmin()).rejects.toMatchObject({
      type: 'PASSWORD_RECOVERY_REQUIRED',
      message: 'Password recovery must be completed.',
    });
    expect(mocks.getClaims).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.resolveAdmin).not.toHaveBeenCalled();
  });

  it('preserves the ordinary signed-in Admin path when recovery context is absent', async () => {
    await expect(requireAdmin()).resolves.toEqual(ADMIN_CONTEXT);
    expect(mocks.getClaims).toHaveBeenCalledOnce();
    expect(mocks.resolveAdmin).toHaveBeenCalledWith(USER_ID, expect.anything());
  });
});
