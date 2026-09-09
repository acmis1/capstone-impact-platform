import type { AdminPermission } from '../auth/authTypes';
import { canManageStaff } from '../auth/permissions';
import {
  staffLifecycleMessage,
  type StaffLifecycleInput,
  type StaffLifecycleResultCode,
  type StaffLifecycleState,
  validateStaffLifecycleInput,
} from './staffLifecycle';

export type StaffProviderAction = 'none' | 'disable' | 'enable';

export interface StaffLifecycleDatabaseOutcome {
  resultCode: string;
  staff: StaffLifecycleState | null;
  providerAction: StaffProviderAction | null;
  eventId: string | null;
  reconciliationToken: string | null;
  authUserId: string | null;
}

export interface StaffLifecycleDatabaseGateway {
  apply(input: StaffLifecycleInput & { actorAdminUserId: string }): Promise<StaffLifecycleDatabaseOutcome>;
  claimProviderReconciliation(input: {
    actorAdminUserId: string;
    targetEmail: string;
    expectedVersion: number;
  }): Promise<StaffLifecycleDatabaseOutcome>;
  completeProviderReconciliation(input: {
    eventId: string;
    reconciliationToken: string;
    succeeded: boolean;
    failureCode: string | null;
  }): Promise<string>;
}

export interface StaffAccessProviderGateway {
  setAccessEnabled(authUserId: string, enabled: boolean): Promise<boolean>;
}

export interface StaffLifecycleRequestContext {
  permissions: AdminPermission[];
  actorAdminUserId: string;
  database: StaffLifecycleDatabaseGateway;
  provider: StaffAccessProviderGateway;
}

export interface StaffLifecycleResult {
  code: StaffLifecycleResultCode;
  message: string;
  staff: StaffLifecycleState | null;
}

function result(
  code: StaffLifecycleResultCode,
  staff: StaffLifecycleState | null = null,
): StaffLifecycleResult {
  return { code, message: staffLifecycleMessage(code, staff), staff };
}

const TERMINAL_DATABASE_CODES = new Set<StaffLifecycleResultCode>([
  'NO_CHANGE',
  'ALREADY_ACTIVE',
  'ALREADY_DEACTIVATED',
  'ALREADY_SYNCHRONIZED',
  'IN_PROGRESS',
  'VALIDATION_FAILED',
  'PERMISSION_DENIED',
  'TARGET_NOT_FOUND',
  'SELF_MODIFICATION_DENIED',
  'LAST_ADMIN_PROTECTED',
  'STALE_VERSION',
  'INVALID_STATE',
  'PROVIDER_RECONCILIATION_REQUIRED',
  'NOTHING_TO_RECONCILE',
]);

/**
 * Runs one lifecycle request. PostgreSQL always commits the authorization transition first;
 * provider failure is then recorded without compensating or restoring database authorization.
 */
export async function manageStaffLifecycle(
  context: StaffLifecycleRequestContext,
  rawInput: unknown,
): Promise<StaffLifecycleResult> {
  if (!canManageStaff(context.permissions)) return result('PERMISSION_DENIED');

  const validation = validateStaffLifecycleInput(rawInput);
  if (!validation.valid) return result('VALIDATION_FAILED');
  const input = validation.data;

  let databaseOutcome: StaffLifecycleDatabaseOutcome;
  try {
    databaseOutcome = input.action === 'reconcile'
      ? await context.database.claimProviderReconciliation({
        actorAdminUserId: context.actorAdminUserId,
        targetEmail: input.targetEmail,
        expectedVersion: input.expectedVersion,
      })
      : await context.database.apply({ ...input, actorAdminUserId: context.actorAdminUserId });
  } catch {
    return result('LIFECYCLE_FAILED');
  }

  if (TERMINAL_DATABASE_CODES.has(databaseOutcome.resultCode as StaffLifecycleResultCode)) {
    const code = databaseOutcome.resultCode as StaffLifecycleResultCode;
    return result(code, databaseOutcome.staff);
  }
  const providerRequired = databaseOutcome.resultCode === 'UPDATED'
    || databaseOutcome.resultCode === 'CLAIMED';
  if (!providerRequired) return result('LIFECYCLE_FAILED');

  if (databaseOutcome.providerAction === 'none') {
    return databaseOutcome.resultCode === 'UPDATED'
      ? result('UPDATED', databaseOutcome.staff)
      : result('LIFECYCLE_FAILED');
  }

  const { eventId, reconciliationToken, authUserId, providerAction } = databaseOutcome;
  const isReconciliation = input.action === 'reconcile';
  if (!eventId || !reconciliationToken || !authUserId || !providerAction) {
    return result(
      isReconciliation ? 'PROVIDER_PENDING' : 'UPDATED_PROVIDER_PENDING',
      databaseOutcome.staff,
    );
  }

  let providerSucceeded = false;
  try {
    providerSucceeded = await context.provider.setAccessEnabled(
      authUserId,
      providerAction === 'enable',
    );
  } catch {
    providerSucceeded = false;
  }

  try {
    const completion = await context.database.completeProviderReconciliation({
      eventId,
      reconciliationToken,
      succeeded: providerSucceeded,
      failureCode: providerSucceeded ? null : 'PROVIDER_ACCESS_UPDATE_FAILED',
    });
    if (completion !== 'RECORDED') {
      return result(
        isReconciliation ? 'PROVIDER_PENDING' : 'UPDATED_PROVIDER_PENDING',
        databaseOutcome.staff,
      );
    }
  } catch {
    return result(
      isReconciliation ? 'PROVIDER_PENDING' : 'UPDATED_PROVIDER_PENDING',
      databaseOutcome.staff,
    );
  }

  if (!providerSucceeded) {
    const staff = databaseOutcome.staff
      ? { ...databaseOutcome.staff, providerSync: 'attention_required' as const }
      : null;
    return result(isReconciliation ? 'PROVIDER_ATTENTION' : 'UPDATED_PROVIDER_ATTENTION', staff);
  }

  const staff = databaseOutcome.staff
    ? { ...databaseOutcome.staff, providerSync: 'synchronized' as const }
    : null;
  return result(isReconciliation ? 'PROVIDER_SYNCHRONIZED' : 'UPDATED', staff);
}
