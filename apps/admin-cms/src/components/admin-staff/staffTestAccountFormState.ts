import { validatePasswordUpdate } from '../../auth/invitationValidation';
import type { StaffTestAccountResultCode, StaffTestAccountRole } from '../../staff/staffTestAccount';

export type StaffTestAccountPhase = 'idle' | 'submitting' | 'settled';

export interface StaffTestAccountFormState {
  fullName: string;
  email: string;
  password: string;
  confirmation: string;
  roles: StaffTestAccountRole[];
  phase: StaffTestAccountPhase;
  resultCode: StaffTestAccountResultCode | null;
  message: string | null;
}

export const INITIAL_STAFF_TEST_ACCOUNT_FORM_STATE: StaffTestAccountFormState = {
  fullName: '',
  email: '',
  password: '',
  confirmation: '',
  roles: [],
  phase: 'idle',
  resultCode: null,
  message: null,
};

export function canSubmitStaffTestAccount(state: StaffTestAccountFormState): boolean {
  if (state.phase === 'submitting') return false;
  if (state.fullName.trim() === '' || state.email.trim() === '' || state.roles.length === 0) {
    return false;
  }
  return validatePasswordUpdate({
    password: state.password,
    confirmation: state.confirmation,
  }).isValid;
}

export function toggleStaffTestAccountRole(
  roles: StaffTestAccountRole[],
  role: StaffTestAccountRole,
): StaffTestAccountRole[] {
  const next = new Set(roles);
  if (next.has(role)) next.delete(role);
  else next.add(role);
  return (['reviewer', 'editor'] as const).filter((candidate) => next.has(candidate));
}

export function applyStaffTestAccountOutcome(
  state: StaffTestAccountFormState,
  outcome: { code: StaffTestAccountResultCode; message: string },
): StaffTestAccountFormState {
  const succeeded = outcome.code === 'ACCOUNT_READY';
  return {
    ...state,
    fullName: succeeded ? '' : state.fullName,
    email: succeeded ? '' : state.email,
    roles: succeeded ? [] : state.roles,
    // Never retain a submitted credential after an attempt settles.
    password: '',
    confirmation: '',
    phase: 'settled',
    resultCode: outcome.code,
    message: outcome.message,
  };
}

export function staffTestAccountAlertVariant(
  code: StaffTestAccountResultCode | null,
): 'success' | 'warning' | 'destructive' | null {
  if (!code) return null;
  if (code === 'ACCOUNT_READY') return 'success';
  if (
    code === 'IN_PROGRESS'
    || code === 'ALREADY_INVITED'
    || code === 'ALREADY_PROVISIONED'
    || code === 'VALIDATION_FAILED'
  ) {
    return 'warning';
  }
  return 'destructive';
}
