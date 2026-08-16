import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  provisionStaffTestAccount: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ serverClient: true })),
  isStaffProvisioningEnabled: vi.fn(() => true),
  isVerifiedStagingRuntime: vi.fn(() => true),
}));

vi.mock('../../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../../staff/staffTestAccountService', () => ({
  provisionStaffTestAccount: mocks.provisionStaffTestAccount,
}));
vi.mock('../../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock('../../../../staff/staffProvisioningEnablement', () => ({
  isStaffProvisioningEnabled: mocks.isStaffProvisioningEnabled,
}));
vi.mock('../../../../security/stagingRuntimeIdentity', () => ({
  isVerifiedStagingRuntime: mocks.isVerifiedStagingRuntime,
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
const SYNTHETIC_PASSWORD = 'SyntheticOnly!234';
const VALID_BODY = {
  fullName: 'Synthetic UAT Staff',
  email: 'uat.staff@capstone.test',
  password: SYNTHETIC_PASSWORD,
  confirmation: SYNTHETIC_PASSWORD,
  roles: ['reviewer', 'editor'],
};

function request(options?: { origin?: string | null; body?: unknown; malformed?: boolean }) {
  const origin = options?.origin === undefined ? 'http://app.test' : options.origin;
  return new NextRequest('http://app.test/api/staff/test-accounts', {
    method: 'POST',
    headers: {
      ...(origin === null ? {} : { origin }),
      'content-type': 'application/json',
    },
    body: options?.malformed
      ? '{bad-json'
      : options?.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });
}

describe('POST /api/staff/test-accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.isStaffProvisioningEnabled.mockReturnValue(true);
    mocks.isVerifiedStagingRuntime.mockReturnValue(true);
    mocks.provisionStaffTestAccount.mockResolvedValue({
      code: 'ACCOUNT_READY',
      message: 'Staging test account created. The account is ready to sign in.',
    });
  });

  it('accepts a same-origin authorized staging request', async () => {
    const response = await POST(request({ body: VALID_BODY }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      success: true,
      code: 'ACCOUNT_READY',
      message: 'Staging test account created. The account is ready to sign in.',
    });
  });

  it.each([
    ['missing Origin', null],
    ['cross-origin', 'http://evil.test'],
  ])('rejects %s before privileged work', async (_label, origin) => {
    const response = await POST(request({ origin, body: VALID_BODY }));
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('maps unauthenticated callers without constructing a service client', async () => {
    mocks.requireAdmin.mockRejectedValue(new AdminAuthError('UNAUTHENTICATED', 'synthetic'));
    const response = await POST(request({ body: VALID_BODY }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('denies staff without staff.manage', async () => {
    mocks.requireAdmin.mockResolvedValue(REVIEWER);
    const response = await POST(request({ body: VALID_BODY }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(mocks.isVerifiedStagingRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when runtime identity is not verified staging', async () => {
    mocks.isVerifiedStagingRuntime.mockReturnValue(false);
    const response = await POST(request({ body: VALID_BODY }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'STAGING_ONLY' });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('fails closed when provisioning is disabled', async () => {
    mocks.isStaffProvisioningEnabled.mockReturnValue(false);
    const response = await POST(request({ body: VALID_BODY }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'PROVISIONING_DISABLED' });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ['Administrator role', { ...VALID_BODY, roles: ['admin'] }],
    ['Administrator + Editor', { ...VALID_BODY, roles: ['admin', 'editor'] }],
    ['extra internal field', { ...VALID_BODY, executionToken: 'forged' }],
    ['short password', { ...VALID_BODY, password: 'short', confirmation: 'short' }],
  ])('rejects %s before constructing the privileged client', async (_label, body) => {
    const response = await POST(request({ body }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocks.provisionStaffTestAccount).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON safely', async () => {
    const response = await POST(request({ malformed: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('derives all internal authority from the authenticated session', async () => {
    await POST(request({ body: VALID_BODY }));
    const [context, body] = mocks.provisionStaffTestAccount.mock.calls[0];
    expect(context.actorAdminUserId).toBe(ADMIN.adminUserId);
    expect(context.permissions).toEqual(ADMIN.permissions);
    expect(context.stagingRuntimeVerified).toBe(true);
    expect(context.provisioningEnabled).toBe(true);
    expect(Object.keys(body).sort()).toEqual(Object.keys(VALID_BODY).sort());
  });

  it('returns only bounded fields on provider failure', async () => {
    mocks.provisionStaffTestAccount.mockResolvedValue({
      code: 'ACCOUNT_CREATION_FAILED',
      message: 'The test account could not be created. No staff account was created.',
    });
    const response = await POST(request({ body: VALID_BODY }));
    const payload = await response.json();
    expect(response.status).toBe(500);
    expect(Object.keys(payload).sort()).toEqual(['code', 'message', 'success']);
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      SYNTHETIC_PASSWORD,
      'authUserId',
      'requestId',
      'executionToken',
      'ownershipToken',
      'service_role',
      'access_token',
      'refresh_token',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('never returns raw thrown provider detail', async () => {
    mocks.provisionStaffTestAccount.mockRejectedValue(
      new Error('synthetic provider detail for auth.users'),
    );
    const response = await POST(request({ body: VALID_BODY }));
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(500);
    expect(serialized).not.toContain('auth.users');
    expect(serialized).not.toContain('synthetic provider detail');
  });
});
