import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  manageStaffLifecycle: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ serverClient: true })),
}));

vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../staff/staffLifecycleService', () => ({
  manageStaffLifecycle: mocks.manageStaffLifecycle,
}));
vi.mock('../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { NextRequest } from 'next/server';
import { AdminAuthError } from '../../../../auth/authTypes';
import { getPermissionsForRoles } from '../../../../auth/permissions';
import { POST } from './route';

const ADMIN = {
  adminUserId: 'server-admin-id',
  authUserId: 'server-auth-id',
  permissions: getPermissionsForRoles(['admin']),
};
const REVIEWER = {
  adminUserId: 'server-reviewer-id',
  authUserId: 'server-reviewer-auth-id',
  permissions: getPermissionsForRoles(['reviewer']),
};
const VALID_BODY = {
  action: 'deactivate',
  targetEmail: 'staff@example.com',
  expectedVersion: 3,
};

function request(options?: { origin?: string | null; body?: unknown }) {
  const origin = options?.origin === undefined ? 'http://app.test' : options.origin;
  return new NextRequest('http://app.test/api/staff/lifecycle', {
    method: 'POST',
    headers: {
      ...(origin === null ? {} : { origin }),
      'content-type': 'application/json',
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe('POST /api/staff/lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.manageStaffLifecycle.mockResolvedValue({
      code: 'UPDATED_PROVIDER_ATTENTION',
      message: 'Admin/CMS access is deactivated. Sign-in cleanup needs attention.',
      staff: {
        email: 'staff@example.com',
        roles: [],
        status: 'deactivated',
        version: 4,
        providerSync: 'attention_required',
      },
    });
  });

  it('returns only bounded lifecycle facts for an authorized same-origin request', async () => {
    const response = await POST(request({ body: VALID_BODY }));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toEqual({
      success: true,
      code: 'UPDATED_PROVIDER_ATTENTION',
      message: 'Admin/CMS access is deactivated. Sign-in cleanup needs attention.',
      staff: {
        email: 'staff@example.com',
        roles: [],
        status: 'deactivated',
        version: 4,
        providerSync: 'attention_required',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('server-admin-id');
    expect(JSON.stringify(payload)).not.toContain('server-auth-id');
  });

  it.each([
    ['a missing Origin header', null],
    ['a cross-origin request', 'http://evil.test'],
    ['a scheme mismatch', 'https://app.test'],
  ])('rejects %s before authentication', async (_label, origin) => {
    const response = await POST(request({ origin, body: VALID_BODY }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'CROSS_ORIGIN_REJECTED' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.manageStaffLifecycle).not.toHaveBeenCalled();
  });

  it('denies staff without staff.manage', async () => {
    mocks.requireAdmin.mockResolvedValue(REVIEWER);

    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(mocks.manageStaffLifecycle).not.toHaveBeenCalled();
  });

  it('derives actor identity and permissions only from the authenticated session', async () => {
    const hostileBody = { ...VALID_BODY, actorAdminUserId: 'attacker', permissions: ['staff.manage'] };
    await POST(request({ body: hostileBody }));

    const [context, body] = mocks.manageStaffLifecycle.mock.calls[0];
    expect(context.actorAdminUserId).toBe(ADMIN.adminUserId);
    expect(context.permissions).toEqual(ADMIN.permissions);
    expect(body).toEqual(hostileBody);
  });

  it.each([
    ['VALIDATION_FAILED', 400],
    ['PERMISSION_DENIED', 403],
    ['TARGET_NOT_FOUND', 404],
    ['STALE_VERSION', 409],
    ['SELF_MODIFICATION_DENIED', 409],
    ['LAST_ADMIN_PROTECTED', 409],
    ['PROVIDER_RECONCILIATION_REQUIRED', 409],
    ['PROVIDER_ATTENTION', 502],
    ['LIFECYCLE_FAILED', 500],
  ])('maps %s to HTTP %i', async (code, status) => {
    mocks.manageStaffLifecycle.mockResolvedValue({ code, message: 'Bounded message.', staff: null });

    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, code });
  });

  it('maps a deactivated authenticated identity to the governed denial', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('STAFF_DEACTIVATED', 'internal'));

    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'STAFF_DEACTIVATED',
      error: 'Access denied.',
    });
  });

  it('never returns internal failure detail', async () => {
    mocks.manageStaffLifecycle.mockRejectedValue(new Error('provider user uuid secret'));

    const response = await POST(request({ body: VALID_BODY }));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(payload)).not.toContain('uuid');
    expect(JSON.stringify(payload)).not.toContain('secret');
  });
});
