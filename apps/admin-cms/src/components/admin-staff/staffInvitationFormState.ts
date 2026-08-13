import type { AdminRole } from '../../auth/authTypes';
import type { StaffProvisioningResultCode } from '../../staff/staffProvisioning';

export type StaffInvitationPhase = 'idle' | 'submitting' | 'settled';

export interface StaffInvitationFormState {
  fullName: string;
  email: string;
  roles: AdminRole[];
  phase: StaffInvitationPhase;
  resultCode: StaffProvisioningResultCode | null;
  message: string | null;
}

export const INITIAL_STAFF_INVITATION_FORM_STATE: StaffInvitationFormState = {
  fullName: '',
  email: '',
  roles: [],
  phase: 'idle',
  resultCode: null,
  message: null,
};

/**
 * Duplicate-submit protection. A submission is permitted only while nothing is in flight and the
 * locally-checkable fields are present. This is a usability guard on top of — never instead of —
 * the server's authorization, validation and durable single-lifecycle convergence.
 */
export function canSubmitStaffInvitation(state: StaffInvitationFormState): boolean {
  if (state.phase === 'submitting') return false;
  if (state.fullName.trim() === '') return false;
  if (state.email.trim() === '') return false;
  return state.roles.length > 0;
}

/** Toggling a role never produces duplicates or an unrecognized value. */
export function toggleStaffRole(roles: AdminRole[], role: AdminRole): AdminRole[] {
  const next = new Set(roles);
  if (next.has(role)) next.delete(role);
  else next.add(role);
  return (['admin', 'reviewer', 'editor'] as const).filter((candidate) => next.has(candidate));
}

/** A settled outcome that produced a pending invitation clears the form for the next request. */
export function applyStaffInvitationOutcome(
  state: StaffInvitationFormState,
  outcome: { code: StaffProvisioningResultCode; message: string },
): StaffInvitationFormState {
  const succeeded = outcome.code === 'INVITATION_PENDING';
  return {
    ...state,
    fullName: succeeded ? '' : state.fullName,
    email: succeeded ? '' : state.email,
    roles: succeeded ? [] : state.roles,
    phase: 'settled',
    resultCode: outcome.code,
    message: outcome.message,
  };
}

/** Only a pending invitation is a success; every other bounded code is surfaced as a problem. */
export function staffInvitationAlertVariant(
  code: StaffProvisioningResultCode | null,
): 'success' | 'warning' | 'destructive' | null {
  if (!code) return null;
  if (code === 'INVITATION_PENDING') return 'success';
  if (code === 'ALREADY_INVITED' || code === 'ALREADY_PROVISIONED' || code === 'VALIDATION_FAILED') {
    return 'warning';
  }
  return 'destructive';
}
