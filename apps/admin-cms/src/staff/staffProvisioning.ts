import type { AdminRole } from '../auth/authTypes';
import { CANONICAL_ROLE_ORDER, isAdminRole } from '../auth/permissions';

/**
 * Bounded domain results for the staff provisioning workflow. Nothing outside this union ever
 * reaches a caller, so raw Supabase errors, SQL, stack traces, Auth user IDs, access tokens and
 * invitation URLs cannot leak through the boundary.
 */
export type StaffProvisioningResultCode =
  | 'INVITATION_PENDING'
  | 'IN_PROGRESS'
  | 'ALREADY_INVITED'
  | 'ALREADY_PROVISIONED'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'PROVISIONING_DISABLED'
  | 'INVITATION_FAILED'
  | 'PROVISIONING_FAILED'
  | 'COMPENSATION_FAILED';

/** Durable lifecycle states, mirroring the Migration 0022 state machine exactly. */
export type StaffProvisioningStatus =
  | 'reserved'
  | 'invited'
  | 'pending_activation'
  | 'activated'
  | 'compensating'
  | 'failed'
  | 'compensation_failed';

/** Lifecycle states in which a staff identity is deliberately not yet usable. */
export const PENDING_STAFF_STATUSES: readonly StaffProvisioningStatus[] = ['pending_activation'];

export interface StaffInvitationInput {
  fullName: string;
  email: string;
  roles: AdminRole[];
}

export type StaffInvitationValidation =
  | { valid: true; data: StaffInvitationInput }
  | { valid: false; code: 'VALIDATION_FAILED'; field: 'fullName' | 'email' | 'roles' };

const MAX_EMAIL_LENGTH = 254;
const MAX_FULL_NAME_LENGTH = 200;

/**
 * Deliberately the same shape as the Migration 0022 server-side check. Normalization happens
 * exactly once, here, and the normalized values are what get validated, stored, audited and
 * echoed back — validation and storage can never disagree about what the identity is.
 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

export function normalizeStaffEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeStaffFullName(value: string): string {
  return value.trim();
}

/**
 * Validates and canonicalizes a staff invitation request at the trusted server boundary.
 * Role names are never trusted merely because they arrived from a select control.
 */
export function validateStaffInvitationInput(raw: unknown): StaffInvitationValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'email' };
  }

  const candidate = raw as { fullName?: unknown; email?: unknown; roles?: unknown };

  if (typeof candidate.fullName !== 'string') {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'fullName' };
  }
  const fullName = normalizeStaffFullName(candidate.fullName);
  if (fullName === '' || fullName.length > MAX_FULL_NAME_LENGTH) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'fullName' };
  }

  if (typeof candidate.email !== 'string') {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'email' };
  }
  const email = normalizeStaffEmail(candidate.email);
  if (email === '' || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'email' };
  }

  if (!Array.isArray(candidate.roles) || candidate.roles.length === 0) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'roles' };
  }
  const recognized = new Set<AdminRole>();
  for (const role of candidate.roles) {
    const normalized = typeof role === 'string' ? role.trim().toLowerCase() : role;
    if (!isAdminRole(normalized)) {
      return { valid: false, code: 'VALIDATION_FAILED', field: 'roles' };
    }
    recognized.add(normalized);
  }
  const roles = CANONICAL_ROLE_ORDER.filter((role) => recognized.has(role));

  return { valid: true, data: { fullName, email, roles } };
}

/**
 * Public, bounded message for each domain result. Deliberately says nothing about internal
 * provider responses, service-role failures or Auth identities.
 */
export function staffProvisioningMessage(code: StaffProvisioningResultCode): string {
  switch (code) {
    case 'INVITATION_PENDING':
      return 'Invitation sent. The staff member gains access once they complete account setup.';
    case 'IN_PROGRESS':
      return 'An invitation for this email address is already being processed.';
    case 'ALREADY_INVITED':
      return 'An invitation for this email address is already awaiting activation.';
    case 'ALREADY_PROVISIONED':
      return 'A staff account already exists for this email address.';
    case 'VALIDATION_FAILED':
      return 'Check the name, email address and selected roles, then try again.';
    case 'PERMISSION_DENIED':
      return 'Access denied.';
    case 'PROVISIONING_DISABLED':
      return 'Staff provisioning is not enabled in this environment.';
    case 'INVITATION_FAILED':
      return 'The invitation could not be sent. No staff account was created.';
    case 'COMPENSATION_FAILED':
      return 'Provisioning stopped in an incomplete state and needs administrator attention.';
    case 'PROVISIONING_FAILED':
    default:
      return 'Provisioning could not be completed. No staff account was created.';
  }
}
