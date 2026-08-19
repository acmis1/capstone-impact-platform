/**
 * Pure validation and routing constants for supported Supabase email-confirmation flows.
 *
 * Only invitation and password-recovery confirmations are supported. The caller never chooses
 * an arbitrary success destination, cookie, or acceptance page.
 */

export const CONFIRMATION_TOKEN_MAX_LENGTH = 2048;

export const INVITATION_COOKIE_NAME = 'capstone_invitation_token_hash';
export const INVITATION_COOKIE_PATH = '/auth/confirm';
export const INVITATION_COOKIE_MAX_AGE_SECONDS = 600;
export const INVITATION_ACCEPT_PATH = '/auth/confirm/accept';
export const INVITATION_PASSWORD_PATH = '/auth/set-password';

export const RECOVERY_TOKEN_COOKIE_NAME = 'capstone_recovery_token_hash';
export const RECOVERY_TOKEN_COOKIE_PATH = '/auth/recovery';
export const RECOVERY_TOKEN_COOKIE_MAX_AGE_SECONDS = 600;
export const RECOVERY_ACCEPT_PATH = '/auth/recovery/accept';
export const RECOVERY_PASSWORD_PATH = '/auth/reset-password';
export const RECOVERY_FAILURE_PATH = '/login?error=RECOVERY_LINK_INVALID';
export const RECOVERY_INVALID_CLEANUP_PATH = '/auth/recovery/invalid';

export type ConfirmationType = 'invite' | 'recovery';
export type ConfirmationDestination =
  | typeof INVITATION_PASSWORD_PATH
  | typeof RECOVERY_PASSWORD_PATH;

export interface ConfirmationParams {
  tokenHash: string | null | undefined;
  type: string | null | undefined;
  next: string | null | undefined;
}

export interface ConfirmationValidationResult {
  isValid: boolean;
  error?: string;
  type?: ConfirmationType;
  next?: ConfirmationDestination;
}

export interface ConfirmationFlow {
  type: ConfirmationType;
  next: ConfirmationDestination;
  acceptPath: typeof INVITATION_ACCEPT_PATH | typeof RECOVERY_ACCEPT_PATH;
  cookieName: typeof INVITATION_COOKIE_NAME | typeof RECOVERY_TOKEN_COOKIE_NAME;
  cookiePath: typeof INVITATION_COOKIE_PATH | typeof RECOVERY_TOKEN_COOKIE_PATH;
  cookieMaxAgeSeconds:
    | typeof INVITATION_COOKIE_MAX_AGE_SECONDS
    | typeof RECOVERY_TOKEN_COOKIE_MAX_AGE_SECONDS;
}

const CONFIRMATION_FLOWS: Record<ConfirmationType, ConfirmationFlow> = {
  invite: {
    type: 'invite',
    next: INVITATION_PASSWORD_PATH,
    acceptPath: INVITATION_ACCEPT_PATH,
    cookieName: INVITATION_COOKIE_NAME,
    cookiePath: INVITATION_COOKIE_PATH,
    cookieMaxAgeSeconds: INVITATION_COOKIE_MAX_AGE_SECONDS,
  },
  recovery: {
    type: 'recovery',
    next: RECOVERY_PASSWORD_PATH,
    acceptPath: RECOVERY_ACCEPT_PATH,
    cookieName: RECOVERY_TOKEN_COOKIE_NAME,
    cookiePath: RECOVERY_TOKEN_COOKIE_PATH,
    cookieMaxAgeSeconds: RECOVERY_TOKEN_COOKIE_MAX_AGE_SECONDS,
  },
};

export function getConfirmationFlow(type: ConfirmationType): ConfirmationFlow {
  return CONFIRMATION_FLOWS[type];
}

export function isConfirmationType(value: string | null | undefined): value is ConfirmationType {
  return value === 'invite' || value === 'recovery';
}

/** Missing/blank destinations preserve the existing invitation defaulting contract. */
export function validateConfirmationNextPath(
  type: ConfirmationType,
  path: string | null | undefined,
): boolean {
  if (!path || path.trim() === '') return true;
  return path.trim() === getConfirmationFlow(type).next;
}

/** Compatibility wrapper for existing invitation-only callers. */
export function validateNextPath(path: string | null | undefined): boolean {
  return validateConfirmationNextPath('invite', path);
}

export function validateConfirmationParams(
  params: ConfirmationParams,
): ConfirmationValidationResult {
  const { tokenHash, type, next } = params;

  if (!tokenHash || typeof tokenHash !== 'string' || tokenHash.trim() === '') {
    return { isValid: false, error: 'MISSING_TOKEN_HASH' };
  }

  if (tokenHash.length > CONFIRMATION_TOKEN_MAX_LENGTH) {
    return { isValid: false, error: 'TOKEN_TOO_LONG' };
  }

  if (!type || typeof type !== 'string' || type.trim() === '') {
    return { isValid: false, error: 'MISSING_TYPE' };
  }

  if (!isConfirmationType(type)) {
    return { isValid: false, error: 'INVALID_TYPE' };
  }

  if (!validateConfirmationNextPath(type, next)) {
    return { isValid: false, error: 'INVALID_NEXT_PATH' };
  }

  return {
    isValid: true,
    type,
    next: getConfirmationFlow(type).next,
  };
}
