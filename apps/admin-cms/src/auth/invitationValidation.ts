/**
 * Pure validation logic for Supabase invitation confirmation
 * and protected set-password pages.
 * 
 * Rules:
 * - Accesses no environment variables
 * - Accesses no network
 * - Logs nothing
 * - Contains no Supabase client
 * - Returns no token, password, or caller-supplied URL values.
 */

export interface ConfirmationParams {
  tokenHash: string | null | undefined;
  type: string | null | undefined;
  next: string | null | undefined;
}

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  type?: 'invite';
  next?: '/auth/set-password';
}

/**
 * Validates next redirect target path.
 * Must be either absent/empty or exactly '/auth/set-password'.
 */
export function validateNextPath(path: string | null | undefined): boolean {
  if (!path) return true;
  return path.trim() === '/auth/set-password';
}

/**
 * Validates invitation confirmation parameters.
 * Checks token length (max 2048) and enforces that next resolves only to /auth/set-password.
 * Returns only safe result classifications and does NOT return the token hash or dynamic redirect URLs.
 */
export function validateConfirmationParams(params: ConfirmationParams): ValidationResult {
  const { tokenHash, type, next } = params;

  if (!tokenHash || typeof tokenHash !== 'string' || tokenHash.trim() === '') {
    return { isValid: false, error: 'MISSING_TOKEN_HASH' };
  }

  if (tokenHash.length > 2048) {
    return { isValid: false, error: 'TOKEN_TOO_LONG' };
  }

  if (!type || typeof type !== 'string' || type.trim() === '') {
    return { isValid: false, error: 'MISSING_TYPE' };
  }

  if (type !== 'invite') {
    return { isValid: false, error: 'INVALID_TYPE' };
  }

  if (!validateNextPath(next)) {
    return { isValid: false, error: 'INVALID_NEXT_PATH' };
  }

  return {
    isValid: true,
    type: 'invite',
    next: '/auth/set-password'
  };
}

/**
 * Validates password updates.
 * Returns only safe validation status classifications and does NOT return the password.
 */
export function validatePasswordUpdate(params: {
  password: string | null | undefined;
  confirmation: string | null | undefined;
}): ValidationResult {
  const { password, confirmation } = params;

  if (!password || typeof password !== 'string' || password === '') {
    return { isValid: false, error: 'PASSWORD_EMPTY' };
  }

  if (password.length < 12) {
    return { isValid: false, error: 'PASSWORD_TOO_SHORT' };
  }

  if (password.length > 128) {
    return { isValid: false, error: 'PASSWORD_TOO_LONG' };
  }

  if (password !== confirmation) {
    return { isValid: false, error: 'CONFIRMATION_MISMATCH' };
  }

  return {
    isValid: true
  };
}
