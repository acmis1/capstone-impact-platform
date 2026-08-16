import type { AdminRole } from '../auth/authTypes';
import { validatePasswordUpdate } from '../auth/invitationValidation';
import { validateStaffInvitationInput } from './staffProvisioning';

export type StaffTestAccountRole = Exclude<AdminRole, 'admin'>;

export interface StaffTestAccountInput {
  fullName: string;
  email: string;
  password: string;
  confirmation: string;
  roles: StaffTestAccountRole[];
}

export type StaffTestAccountValidation =
  | { valid: true; data: StaffTestAccountInput }
  | {
      valid: false;
      code: 'VALIDATION_FAILED';
      field: 'body' | 'fullName' | 'email' | 'password' | 'confirmation' | 'roles';
    };

export type StaffTestAccountResultCode =
  | 'ACCOUNT_READY'
  | 'IN_PROGRESS'
  | 'ALREADY_INVITED'
  | 'ALREADY_PROVISIONED'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'PROVISIONING_DISABLED'
  | 'STAGING_ONLY'
  | 'ACCOUNT_CREATION_FAILED'
  | 'PROVISIONING_FAILED'
  | 'COMPENSATION_FAILED';

export interface StaffTestAccountResult {
  code: StaffTestAccountResultCode;
  message: string;
}

const ALLOWED_KEYS = new Set(['fullName', 'email', 'password', 'confirmation', 'roles']);
const ALLOWED_ROLES = new Set<StaffTestAccountRole>(['reviewer', 'editor']);

/**
 * Strict direct-account input boundary. Unlike invitation onboarding, this path accepts only the
 * five documented browser fields and only canonical non-admin role names.
 */
export function validateStaffTestAccountInput(raw: unknown): StaffTestAccountValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'body' };
  }

  const keys = Object.keys(raw);
  if (keys.length !== ALLOWED_KEYS.size || keys.some((key) => !ALLOWED_KEYS.has(key))) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'body' };
  }

  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.roles) || candidate.roles.length === 0) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'roles' };
  }
  if (
    candidate.roles.some(
      (role): boolean => typeof role !== 'string' || !ALLOWED_ROLES.has(role as StaffTestAccountRole),
    )
  ) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'roles' };
  }

  const staff = validateStaffInvitationInput({
    fullName: candidate.fullName,
    email: candidate.email,
    roles: candidate.roles,
  });
  if (!staff.valid) {
    return { valid: false, code: 'VALIDATION_FAILED', field: staff.field };
  }

  if (typeof candidate.password !== 'string') {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'password' };
  }
  if (typeof candidate.confirmation !== 'string') {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'confirmation' };
  }
  if (
    !validatePasswordUpdate({
      password: candidate.password,
      confirmation: candidate.confirmation,
    }).isValid
  ) {
    return { valid: false, code: 'VALIDATION_FAILED', field: 'password' };
  }

  return {
    valid: true,
    data: {
      fullName: staff.data.fullName,
      email: staff.data.email,
      password: candidate.password,
      confirmation: candidate.confirmation,
      roles: staff.data.roles as StaffTestAccountRole[],
    },
  };
}

/** Safe, bounded browser copy for direct staging account outcomes. */
export function staffTestAccountMessage(code: StaffTestAccountResultCode): string {
  switch (code) {
    case 'ACCOUNT_READY':
      return 'Staging test account created. The account is ready to sign in.';
    case 'IN_PROGRESS':
      return 'A staff account for this email address is already being processed.';
    case 'ALREADY_INVITED':
      return 'An invitation for this email address is already awaiting activation.';
    case 'ALREADY_PROVISIONED':
      return 'A staff account already exists for this email address.';
    case 'VALIDATION_FAILED':
      return 'Check the name, login, password confirmation and selected roles, then try again.';
    case 'PERMISSION_DENIED':
      return 'Access denied.';
    case 'PROVISIONING_DISABLED':
      return 'Staff provisioning is not enabled in this environment.';
    case 'STAGING_ONLY':
      return 'Staging test account creation is unavailable in this environment.';
    case 'ACCOUNT_CREATION_FAILED':
      return 'The test account could not be created. No staff account was created.';
    case 'COMPENSATION_FAILED':
      return 'Provisioning stopped in an incomplete state and needs administrator attention.';
    case 'PROVISIONING_FAILED':
    default:
      return 'Provisioning could not be completed. No staff account was created.';
  }
}
