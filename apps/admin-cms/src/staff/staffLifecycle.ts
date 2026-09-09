import type { AdminRole } from '../auth/authTypes';
import { CANONICAL_ROLE_ORDER, isAdminRole } from '../auth/permissions';
import { normalizeStaffEmail } from './staffProvisioning';

export type StaffLifecycleAction = 'replace_roles' | 'deactivate' | 'reactivate' | 'reconcile';
export type StaffLifecycleStatus = 'active' | 'pending_activation' | 'deactivated';
export type StaffProviderSync = 'synchronized' | 'pending' | 'attention_required';

export interface StaffLifecycleState {
  email: string;
  roles: AdminRole[];
  status: StaffLifecycleStatus;
  version: number;
  providerSync: StaffProviderSync;
}

export type StaffLifecycleResultCode =
  | 'UPDATED'
  | 'NO_CHANGE'
  | 'ALREADY_ACTIVE'
  | 'ALREADY_DEACTIVATED'
  | 'PROVIDER_SYNCHRONIZED'
  | 'ALREADY_SYNCHRONIZED'
  | 'UPDATED_PROVIDER_PENDING'
  | 'UPDATED_PROVIDER_ATTENTION'
  | 'PROVIDER_PENDING'
  | 'PROVIDER_ATTENTION'
  | 'IN_PROGRESS'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'TARGET_NOT_FOUND'
  | 'SELF_MODIFICATION_DENIED'
  | 'LAST_ADMIN_PROTECTED'
  | 'STALE_VERSION'
  | 'INVALID_STATE'
  | 'PROVIDER_RECONCILIATION_REQUIRED'
  | 'NOTHING_TO_RECONCILE'
  | 'LIFECYCLE_FAILED';

export interface StaffLifecycleInput {
  action: StaffLifecycleAction;
  targetEmail: string;
  expectedVersion: number;
  roles: AdminRole[] | null;
}

export type StaffLifecycleValidation =
  | { valid: true; data: StaffLifecycleInput }
  | { valid: false; code: 'VALIDATION_FAILED' };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;
const ACTIONS = new Set<StaffLifecycleAction>([
  'replace_roles',
  'deactivate',
  'reactivate',
  'reconcile',
]);

/** Strict browser boundary. Internal profile/Auth/event identifiers are never accepted. */
export function validateStaffLifecycleInput(raw: unknown): StaffLifecycleValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, code: 'VALIDATION_FAILED' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.action !== 'string' || !ACTIONS.has(record.action as StaffLifecycleAction)) {
    return { valid: false, code: 'VALIDATION_FAILED' };
  }
  const action = record.action as StaffLifecycleAction;
  const expectedKeys = action === 'replace_roles' || action === 'reactivate'
    ? ['action', 'expectedVersion', 'roles', 'targetEmail']
    : ['action', 'expectedVersion', 'targetEmail'];
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { valid: false, code: 'VALIDATION_FAILED' };
  }

  if (typeof record.targetEmail !== 'string') {
    return { valid: false, code: 'VALIDATION_FAILED' };
  }
  const targetEmail = normalizeStaffEmail(record.targetEmail);
  if (targetEmail.length === 0 || targetEmail.length > 254 || !EMAIL_PATTERN.test(targetEmail)) {
    return { valid: false, code: 'VALIDATION_FAILED' };
  }
  if (!Number.isSafeInteger(record.expectedVersion) || (record.expectedVersion as number) < 1) {
    return { valid: false, code: 'VALIDATION_FAILED' };
  }

  let roles: AdminRole[] | null = null;
  if (action === 'replace_roles' || action === 'reactivate') {
    if (!Array.isArray(record.roles) || record.roles.length === 0 || record.roles.length > 3) {
      return { valid: false, code: 'VALIDATION_FAILED' };
    }
    const recognized = new Set<AdminRole>();
    for (const rawRole of record.roles) {
      const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : rawRole;
      if (!isAdminRole(role)) return { valid: false, code: 'VALIDATION_FAILED' };
      recognized.add(role);
    }
    roles = CANONICAL_ROLE_ORDER.filter((role) => recognized.has(role));
  }

  return {
    valid: true,
    data: {
      action,
      targetEmail,
      expectedVersion: record.expectedVersion as number,
      roles,
    },
  };
}

export function staffLifecycleMessage(
  code: StaffLifecycleResultCode,
  staff: StaffLifecycleState | null = null,
): string {
  switch (code) {
    case 'UPDATED':
      return 'Staff access updated.';
    case 'NO_CHANGE':
      return 'The requested staff access is already current.';
    case 'ALREADY_ACTIVE':
      return 'This staff account is already active with those roles.';
    case 'ALREADY_DEACTIVATED':
      return 'This staff account is already deactivated.';
    case 'PROVIDER_SYNCHRONIZED':
    case 'ALREADY_SYNCHRONIZED':
      return 'Sign-in access is synchronized.';
    case 'UPDATED_PROVIDER_PENDING':
      return staff?.status === 'deactivated'
        ? 'Admin/CMS access is deactivated. Sign-in cleanup is still pending.'
        : staff?.status === 'pending_activation'
          ? 'Staff access still awaits account setup. Sign-in synchronization is also pending.'
        : 'Admin/CMS access is active. Sign-in restoration is still pending.';
    case 'UPDATED_PROVIDER_ATTENTION':
      return staff?.status === 'deactivated'
        ? 'Admin/CMS access is deactivated. Sign-in cleanup needs attention.'
        : staff?.status === 'pending_activation'
          ? 'Staff access still awaits account setup. Sign-in synchronization needs attention.'
        : 'Admin/CMS access is active, but sign-in restoration needs attention.';
    case 'PROVIDER_PENDING':
      return 'Sign-in access synchronization is still pending.';
    case 'PROVIDER_ATTENTION':
      return 'Sign-in access synchronization still needs attention.';
    case 'IN_PROGRESS':
      return 'Another sign-in access synchronization attempt is in progress.';
    case 'VALIDATION_FAILED':
      return 'Check the staff account, version and selected roles, then try again.';
    case 'PERMISSION_DENIED':
      return 'Access denied.';
    case 'TARGET_NOT_FOUND':
      return 'The staff account is unavailable for lifecycle management.';
    case 'SELF_MODIFICATION_DENIED':
      return 'You cannot change or deactivate your own staff access.';
    case 'LAST_ADMIN_PROTECTED':
      return 'The last effective Administrator cannot be removed or deactivated.';
    case 'STALE_VERSION':
      return 'Staff access changed since this page loaded. Refresh and review the current state.';
    case 'INVALID_STATE':
      return 'That lifecycle action is not valid for the current staff state.';
    case 'PROVIDER_RECONCILIATION_REQUIRED':
      return 'Resolve the pending sign-in access synchronization before making another change.';
    case 'NOTHING_TO_RECONCILE':
      return 'There is no pending sign-in access synchronization for this staff account.';
    case 'LIFECYCLE_FAILED':
    default:
      return 'Staff access could not be updated. Refresh before trying again.';
  }
}
