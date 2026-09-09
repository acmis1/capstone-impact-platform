import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import {
  manageStaffLifecycle,
  type StaffLifecycleDatabaseOutcome,
  type StaffLifecycleRequestContext,
} from './staffLifecycleService';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const AUTH_USER = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const DEACTIVATED = {
  email: 'staff@example.com',
  roles: [],
  status: 'deactivated' as const,
  version: 2,
  providerSync: 'pending' as const,
};
const DEACTIVATE = {
  action: 'deactivate',
  targetEmail: 'staff@example.com',
  expectedVersion: 1,
};

function parts(outcome: Partial<StaffLifecycleDatabaseOutcome> = {}) {
  const value: StaffLifecycleDatabaseOutcome = {
    resultCode: 'UPDATED',
    staff: DEACTIVATED,
    providerAction: 'disable',
    eventId: EVENT,
    reconciliationToken: TOKEN,
    authUserId: AUTH_USER,
    ...outcome,
  };
  return {
    database: {
      apply: vi.fn().mockResolvedValue(value),
      claimProviderReconciliation: vi.fn().mockResolvedValue({
        ...value,
        resultCode: 'CLAIMED',
      }),
      completeProviderReconciliation: vi.fn().mockResolvedValue('RECORDED'),
    },
    provider: { setAccessEnabled: vi.fn().mockResolvedValue(true) },
  };
}

function context(
  gateways: ReturnType<typeof parts>,
  permissions = getPermissionsForRoles(['admin']),
): StaffLifecycleRequestContext {
  return { permissions, actorAdminUserId: ACTOR, ...gateways };
}

describe('manageStaffLifecycle', () => {
  it('denies callers without staff.manage before any gateway call', async () => {
    const gateways = parts();
    expect((await manageStaffLifecycle(
      context(gateways, getPermissionsForRoles(['reviewer'])),
      DEACTIVATE,
    )).code).toBe('PERMISSION_DENIED');
    expect(gateways.database.apply).not.toHaveBeenCalled();
    expect(gateways.provider.setAccessEnabled).not.toHaveBeenCalled();
  });

  it('returns an atomic role replacement without calling the provider', async () => {
    const staff = { ...DEACTIVATED, status: 'active' as const, roles: ['reviewer' as const] };
    const gateways = parts({ staff, providerAction: 'none', eventId: null,
      reconciliationToken: null, authUserId: null });
    const outcome = await manageStaffLifecycle(context(gateways), {
      action: 'replace_roles',
      targetEmail: staff.email,
      expectedVersion: 1,
      roles: ['reviewer'],
    });
    expect(outcome).toMatchObject({ code: 'UPDATED', staff });
    expect(gateways.provider.setAccessEnabled).not.toHaveBeenCalled();
  });

  it('attempts provider disable only after authoritative DB deactivation', async () => {
    const gateways = parts();
    await manageStaffLifecycle(context(gateways), DEACTIVATE);
    expect(gateways.database.apply).toHaveBeenCalledTimes(1);
    expect(gateways.provider.setAccessEnabled).toHaveBeenCalledWith(AUTH_USER, false);
    expect(gateways.database.apply.mock.invocationCallOrder[0])
      .toBeLessThan(gateways.provider.setAccessEnabled.mock.invocationCallOrder[0]);
  });

  it('never rolls back deactivation when the provider fails', async () => {
    const gateways = parts();
    gateways.provider.setAccessEnabled.mockResolvedValue(false);
    const outcome = await manageStaffLifecycle(context(gateways), DEACTIVATE);
    expect(outcome).toMatchObject({
      code: 'UPDATED_PROVIDER_ATTENTION',
      staff: { status: 'deactivated', roles: [], providerSync: 'attention_required' },
    });
    expect(gateways.database.apply).toHaveBeenCalledTimes(1);
    expect(gateways.database.completeProviderReconciliation).toHaveBeenCalledWith({
      eventId: EVENT,
      reconciliationToken: TOKEN,
      succeeded: false,
      failureCode: 'PROVIDER_ACCESS_UPDATE_FAILED',
    });
  });

  it('reports pending reconciliation when provider success cannot be recorded', async () => {
    const gateways = parts();
    gateways.database.completeProviderReconciliation.mockRejectedValue(new Error('private DB error'));
    const outcome = await manageStaffLifecycle(context(gateways), DEACTIVATE);
    expect(outcome.code).toBe('UPDATED_PROVIDER_PENDING');
    expect(outcome.staff?.status).toBe('deactivated');
    expect(gateways.database.apply).toHaveBeenCalledTimes(1);
  });

  it('retries the exact current provider action through the reconciliation claim', async () => {
    const gateways = parts();
    const outcome = await manageStaffLifecycle(context(gateways), {
      action: 'reconcile',
      targetEmail: DEACTIVATED.email,
      expectedVersion: 2,
    });
    expect(outcome.code).toBe('PROVIDER_SYNCHRONIZED');
    expect(gateways.database.claimProviderReconciliation).toHaveBeenCalledWith({
      actorAdminUserId: ACTOR,
      targetEmail: DEACTIVATED.email,
      expectedVersion: 2,
    });
    expect(gateways.database.apply).not.toHaveBeenCalled();
  });

  it.each([
    'SELF_MODIFICATION_DENIED',
    'LAST_ADMIN_PROTECTED',
    'STALE_VERSION',
    'PROVIDER_RECONCILIATION_REQUIRED',
  ])('propagates bounded database result %s without provider work', async (resultCode) => {
    const gateways = parts({ resultCode, staff: null, providerAction: null, eventId: null,
      reconciliationToken: null, authUserId: null });
    expect((await manageStaffLifecycle(context(gateways), DEACTIVATE)).code).toBe(resultCode);
    expect(gateways.provider.setAccessEnabled).not.toHaveBeenCalled();
  });
});
