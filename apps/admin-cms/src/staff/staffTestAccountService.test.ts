import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import {
  provisionStaffTestAccount,
  type StaffTestAccountRequestContext,
} from './staffTestAccountService';

const ACTOR = '11111111-1111-1111-1111-111111111111';
const REQUEST_ID = '22222222-2222-2222-2222-222222222222';
const AUTH_ID = '33333333-3333-3333-3333-333333333333';
const EXECUTION_TOKEN = '44444444-4444-4444-4444-444444444444';
const OWNERSHIP_TOKEN = '55555555-5555-5555-5555-555555555555';
const SYNTHETIC_PASSWORD = 'SyntheticOnly!234';
const VALID = {
  fullName: 'Synthetic UAT Staff',
  email: 'uat.staff@capstone.test',
  password: SYNTHETIC_PASSWORD,
  confirmation: SYNTHETIC_PASSWORD,
  roles: ['reviewer', 'editor'],
};

function parts(overrides: Record<string, unknown> = {}) {
  const reserve = vi.fn().mockResolvedValue(overrides.reserve ?? {
    resultCode: 'RESERVED',
    requestId: REQUEST_ID,
    executionToken: EXECUTION_TOKEN,
    authOwnershipToken: OWNERSHIP_TOKEN,
    normalizedEmail: VALID.email,
    fullName: VALID.fullName,
    roles: VALID.roles,
    authUserId: null,
    authIdentityOwned: false,
    status: 'reserved',
  });
  const recoverIdentity = vi.fn().mockResolvedValue(
    overrides.recover ?? { resultCode: 'OWNED_IDENTITY_NOT_FOUND' },
  );
  const bind = vi.fn().mockResolvedValue(
    overrides.bind ?? { resultCode: 'BOUND', authUserId: AUTH_ID, authIdentityOwned: true },
  );
  const finalize = vi.fn().mockResolvedValue({ resultCode: 'UNUSED' });
  const finalizeAndActivate = vi.fn().mockResolvedValue(
    overrides.finalizeAndActivate ?? { resultCode: 'SUCCESS', status: 'activated' },
  );
  const beginCompensation = vi.fn().mockResolvedValue(
    overrides.beginCompensation ?? { resultCode: 'COMPENSATION_AUTHORIZED' },
  );
  const fail = vi.fn().mockResolvedValue(overrides.fail ?? { resultCode: 'FAILED' });
  const createPasswordIdentity = vi.fn().mockResolvedValue(
    Object.prototype.hasOwnProperty.call(overrides, 'create') ? overrides.create : AUTH_ID,
  );
  const deleteAuthIdentity = vi.fn().mockResolvedValue(
    Object.prototype.hasOwnProperty.call(overrides, 'deleteOk') ? overrides.deleteOk : true,
  );
  return {
    provisioning: {
      reserve,
      recoverIdentity,
      bind,
      finalize,
      finalizeAndActivate,
      beginCompensation,
      fail,
    },
    identities: { createPasswordIdentity, deleteAuthIdentity },
  };
}

function context(
  gateways: ReturnType<typeof parts>,
  options: { permissions?: StaffTestAccountRequestContext['permissions']; staging?: boolean; enabled?: boolean } = {},
): StaffTestAccountRequestContext {
  return {
    permissions: options.permissions ?? getPermissionsForRoles(['admin']),
    actorAdminUserId: ACTOR,
    stagingRuntimeVerified: options.staging ?? true,
    provisioningEnabled: options.enabled ?? true,
    ...gateways,
  };
}

describe('provisionStaffTestAccount', () => {
  it('reserves, creates, binds and atomically activates a direct identity', async () => {
    const gateways = parts();
    const outcome = await provisionStaffTestAccount(context(gateways), VALID);

    expect(outcome.code).toBe('ACCOUNT_READY');
    expect(gateways.identities.createPasswordIdentity).toHaveBeenCalledWith({
      email: VALID.email,
      fullName: VALID.fullName,
      password: SYNTHETIC_PASSWORD,
      requestId: REQUEST_ID,
      authOwnershipToken: OWNERSHIP_TOKEN,
    });
    expect(gateways.provisioning.bind).toHaveBeenCalledWith(REQUEST_ID, EXECUTION_TOKEN, AUTH_ID);
    expect(gateways.provisioning.finalizeAndActivate).toHaveBeenCalledWith(
      REQUEST_ID,
      EXECUTION_TOKEN,
    );
    expect(gateways.provisioning.finalize).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_PASSWORD);
    expect(JSON.stringify(outcome)).not.toContain(AUTH_ID);
  });

  it.each([
    ['reviewer', getPermissionsForRoles(['reviewer'])],
    ['editor', getPermissionsForRoles(['editor'])],
    ['reviewer + editor', getPermissionsForRoles(['reviewer', 'editor'])],
  ])('denies %s before privileged work', async (_label, permissions) => {
    const gateways = parts();
    expect((await provisionStaffTestAccount(context(gateways, { permissions }), VALID)).code)
      .toBe('PERMISSION_DENIED');
    expect(gateways.provisioning.reserve).not.toHaveBeenCalled();
  });

  it('fails closed outside verified staging', async () => {
    const gateways = parts();
    expect((await provisionStaffTestAccount(context(gateways, { staging: false }), VALID)).code)
      .toBe('STAGING_ONLY');
    expect(gateways.provisioning.reserve).not.toHaveBeenCalled();
  });

  it('fails closed when provisioning is disabled', async () => {
    const gateways = parts();
    expect((await provisionStaffTestAccount(context(gateways, { enabled: false }), VALID)).code)
      .toBe('PROVISIONING_DISABLED');
    expect(gateways.provisioning.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed body', null],
    ['Administrator role', { ...VALID, roles: ['admin'] }],
    ['bad password', { ...VALID, password: 'short', confirmation: 'short' }],
  ])('rejects %s before privileged work', async (_label, input) => {
    const gateways = parts();
    expect((await provisionStaffTestAccount(context(gateways), input)).code)
      .toBe('VALIDATION_FAILED');
    expect(gateways.provisioning.reserve).not.toHaveBeenCalled();
  });

  it.each(['IN_PROGRESS', 'ALREADY_INVITED', 'ALREADY_PROVISIONED'])
    ('converges on reservation result %s without Auth creation', async (resultCode) => {
      const gateways = parts({ reserve: { resultCode } });
      expect((await provisionStaffTestAccount(context(gateways), VALID)).code).toBe(resultCode);
      expect(gateways.identities.createPasswordIdentity).not.toHaveBeenCalled();
    });

  it('does not recover a durable lifecycle containing Administrator authority', async () => {
    const gateways = parts({
      reserve: {
        resultCode: 'RECOVERED',
        requestId: REQUEST_ID,
        executionToken: EXECUTION_TOKEN,
        authOwnershipToken: OWNERSHIP_TOKEN,
        roles: ['admin'],
      },
    });
    expect((await provisionStaffTestAccount(context(gateways), VALID)).code)
      .toBe('VALIDATION_FAILED');
    expect(gateways.identities.createPasswordIdentity).not.toHaveBeenCalled();
  });

  it('recovers the exact marked identity after a lost createUser response', async () => {
    const gateways = parts({
      create: null,
      recover: { resultCode: 'OWNED_IDENTITY_BOUND', authUserId: AUTH_ID, authIdentityOwned: true },
    });
    expect((await provisionStaffTestAccount(context(gateways), VALID)).code).toBe('ACCOUNT_READY');
    expect(gateways.provisioning.finalizeAndActivate).toHaveBeenCalled();
    expect(gateways.provisioning.fail).not.toHaveBeenCalled();
  });

  it('never claims or deletes an existing unowned identity', async () => {
    const gateways = parts({ create: null, recover: { resultCode: 'OWNED_IDENTITY_NOT_FOUND' } });
    expect((await provisionStaffTestAccount(context(gateways), VALID)).code)
      .toBe('ACCOUNT_CREATION_FAILED');
    expect(gateways.identities.deleteAuthIdentity).not.toHaveBeenCalled();
    expect(gateways.provisioning.fail).toHaveBeenCalledWith(
      REQUEST_ID,
      EXECUTION_TOKEN,
      'ACCOUNT_CREATION_FAILED',
      'not_required',
    );
  });

  it.each(['EXECUTION_TOKEN_MISMATCH', 'EXECUTION_LEASE_EXPIRED'])
    ('treats %s as lost execution ownership', async (resultCode) => {
      const gateways = parts({ bind: { resultCode } });
      expect((await provisionStaffTestAccount(context(gateways), VALID)).code).toBe('IN_PROGRESS');
      expect(gateways.identities.deleteAuthIdentity).not.toHaveBeenCalled();
      expect(gateways.provisioning.fail).not.toHaveBeenCalled();
    });

  it.each(['AUTH_OWNERSHIP_MISMATCH', 'AUTH_EMAIL_MISMATCH', 'AUTH_USER_NOT_FOUND'])
    ('fails bind result %s without deleting an unowned identity', async (resultCode) => {
      const gateways = parts({ bind: { resultCode } });
      expect((await provisionStaffTestAccount(context(gateways), VALID)).code)
        .toBe('PROVISIONING_FAILED');
      expect(gateways.identities.deleteAuthIdentity).not.toHaveBeenCalled();
    });

  it('compensates an exactly owned identity when atomic finalization fails', async () => {
    const gateways = parts({ finalizeAndActivate: { resultCode: 'AUTH_OWNERSHIP_MISMATCH' } });
    expect((await provisionStaffTestAccount(context(gateways), VALID)).code)
      .toBe('PROVISIONING_FAILED');
    expect(gateways.provisioning.beginCompensation).toHaveBeenCalledWith(
      REQUEST_ID,
      EXECUTION_TOKEN,
      AUTH_ID,
    );
    expect(gateways.identities.deleteAuthIdentity).toHaveBeenCalledWith(AUTH_ID);
  });

  it('records compensation failure when owned identity deletion fails', async () => {
    const gateways = parts({
      finalizeAndActivate: { resultCode: 'INVALID_STATE' },
      deleteOk: false,
      fail: { resultCode: 'COMPENSATION_FAILED' },
    });
    expect((await provisionStaffTestAccount(context(gateways), VALID)).code)
      .toBe('COMPENSATION_FAILED');
    expect(gateways.provisioning.fail).toHaveBeenCalledWith(
      REQUEST_ID,
      EXECUTION_TOKEN,
      'FINALIZE_REJECTED',
      'failed',
    );
  });

  it('does not delete when compensation cannot re-prove exact ownership', async () => {
    const gateways = parts({
      finalizeAndActivate: { resultCode: 'INVALID_STATE' },
      beginCompensation: { resultCode: 'COMPENSATION_NOT_AUTHORIZED' },
    });
    expect((await provisionStaffTestAccount(context(gateways), VALID)).code)
      .toBe('COMPENSATION_FAILED');
    expect(gateways.identities.deleteAuthIdentity).not.toHaveBeenCalled();
  });
});
