import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  provisionStaffMember: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ serverClient: true })),
  isStaffProvisioningEnabled: vi.fn(() => true),
}));

vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../staff/staffProvisioningService', () => ({
  provisionStaffMember: mocks.provisionStaffMember,
}));
vi.mock('../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock('../../../../staff/staffProvisioningEnablement', () => ({
  isStaffProvisioningEnabled: mocks.isStaffProvisioningEnabled,
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
const VALID_BODY = { fullName: 'Synthetic Staff', email: 'staff@example.com', roles: ['reviewer'] };

function request(options?: { origin?: string | null; body?: unknown }) {
  const origin = options?.origin === undefined ? 'http://app.test' : options.origin;
  return new NextRequest('http://app.test/api/staff/invitations', {
    method: 'POST',
    headers: {
      ...(origin === null ? {} : { origin }),
      'content-type': 'application/json',
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe('POST /api/staff/invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isStaffProvisioningEnabled.mockReturnValue(true);
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.provisionStaffMember.mockResolvedValue({
      code: 'INVITATION_PENDING',
      message: 'Invitation sent.',
      invitation: { fullName: 'Synthetic Staff', email: 'staff@example.com', roles: ['reviewer'] },
    });
  });

  it('accepts a same-origin request from an authorized administrator', async () => {
    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      success: true,
      code: 'INVITATION_PENDING',
      message: 'Invitation sent.',
      invitation: { fullName: 'Synthetic Staff', email: 'staff@example.com', roles: ['reviewer'] },
    });
  });

  it.each([
    ['a missing Origin header', null],
    ['a cross-origin request', 'http://evil.test'],
    ['a scheme mismatch', 'https://app.test'],
  ])('rejects %s before authenticating', async (_label, origin) => {
    const response = await POST(request({ origin, body: VALID_BODY }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'CROSS_ORIGIN_REJECTED',
      error: 'The request was not accepted.',
    });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.provisionStaffMember).not.toHaveBeenCalled();
  });

  it('denies an authenticated staff member without staff.manage', async () => {
    mocks.requireAdmin.mockResolvedValue(REVIEWER);

    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ success: false, code: 'PERMISSION_DENIED' });
    expect(mocks.provisionStaffMember).not.toHaveBeenCalled();
  });

  it('derives the acting administrator from the session, never the request body', async () => {
    await POST(
      request({
        body: {
          ...VALID_BODY,
          actorAdminUserId: 'attacker-admin',
          permissions: ['staff.manage'],
          status: 'activated',
        },
      }),
    );

    const [context] = mocks.provisionStaffMember.mock.calls[0];
    expect(context.actorAdminUserId).toBe(ADMIN.adminUserId);
    expect(context.permissions).toEqual(ADMIN.permissions);
  });

  it('passes the server-resolved enablement rather than any client value', async () => {
    mocks.isStaffProvisioningEnabled.mockReturnValue(false);
    mocks.provisionStaffMember.mockResolvedValue({
      code: 'PROVISIONING_DISABLED',
      message: 'Staff provisioning is not enabled in this environment.',
    });

    const response = await POST(request({ body: { ...VALID_BODY, provisioningEnabled: true } }));

    expect(response.status).toBe(503);
    const [context] = mocks.provisionStaffMember.mock.calls[0];
    expect(context.provisioningEnabled).toBe(false);
  });

  it.each([
    ['VALIDATION_FAILED', 400],
    ['PERMISSION_DENIED', 403],
    ['ALREADY_INVITED', 409],
    ['ALREADY_PROVISIONED', 409],
    ['PROVISIONING_DISABLED', 503],
    ['INVITATION_FAILED', 500],
    ['PROVISIONING_FAILED', 500],
    ['COMPENSATION_FAILED', 500],
  ])('maps %s to HTTP %i', async (code, status) => {
    mocks.provisionStaffMember.mockResolvedValue({ code, message: 'Bounded message.' });

    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, code });
  });

  it('maps authentication failures to their governed status', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'nope'));

    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      code: 'UNAUTHENTICATED',
      error: 'Authentication required.',
    });
  });

  it('denies an invited-but-unactivated staff identity', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('STAFF_ACTIVATION_PENDING', 'nope'));

    const response = await POST(request({ body: VALID_BODY }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'STAFF_ACTIVATION_PENDING', error: 'Access denied.' });
  });

  it('never leaks internal failure detail', async () => {
    mocks.provisionStaffMember.mockRejectedValue(new Error('relation "auth.users" does not exist'));

    const response = await POST(request({ body: VALID_BODY }));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(payload)).not.toContain('auth.users');
    expect(JSON.stringify(payload)).not.toContain('relation');
  });

  it('tolerates a malformed body by delegating to server-side validation', async () => {
    mocks.provisionStaffMember.mockResolvedValue({ code: 'VALIDATION_FAILED', message: 'Check the fields.' });

    const response = await POST(request());

    expect(response.status).toBe(400);
    const [, body] = mocks.provisionStaffMember.mock.calls[0];
    expect(body).toBeNull();
  });
});
