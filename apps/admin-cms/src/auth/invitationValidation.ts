/**
 * Pure validation logic for Supabase invitation confirmation
 * and protected set-password pages.
 * 
 * Rules:
 * - Accesses no environment variables
 * - Accesses no network
 * - Logs nothing
 * - Contains no Supabase client
 * - Returns no token or password value
 */

export interface ConfirmationParams {
  tokenHash: string | null | undefined;
  type: string | null | undefined;
  next: string | null | undefined;
}

export interface ValidationResult<T> {
  isValid: boolean;
  data?: T;
  error?: string;
}

const ALLOWED_REDIRECT_PATHS = [
  '/auth/set-password',
  '/admin',
  '/login'
];

/**
 * Sanitizes and validates next redirect target path.
 * Rejects external URLs, protocol-relative URLs (//), backslash paths (\\),
 * and encoded redirect variants. Must be in the ALLOWED_REDIRECT_PATHS allow-list.
 */
export function validateNextPath(path: string | null | undefined): string {
  if (!path) {
    return '/auth/set-password';
  }

  let decoded = path.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return '/auth/set-password';
  }

  // Reject paths containing protocol schemes or absolute prefixes
  if (/^(https?:)?\/\//i.test(decoded)) {
    return '/auth/set-password';
  }

  // Reject backslashes
  if (decoded.includes('\\')) {
    return '/auth/set-password';
  }

  // Ensure it starts with exactly one '/' and is not protocol-relative
  if (!decoded.startsWith('/') || decoded.startsWith('//')) {
    return '/auth/set-password';
  }

  // Check against our strict internal allow-list
  // Check either exact match or matches prefix of allowlisted paths if routing parameters are ignored.
  // For safety, let's enforce exact match or clean match against the path part.
  const pathPart = decoded.split('?')[0];
  if (ALLOWED_REDIRECT_PATHS.includes(pathPart)) {
    return decoded;
  }

  return '/auth/set-password';
}

/**
 * Validates invitation confirmation parameters.
 */
export function validateConfirmationParams(params: ConfirmationParams): ValidationResult<{
  tokenHash: string;
  type: 'invite';
  next: string;
}> {
  const { tokenHash, type, next } = params;

  if (!tokenHash || typeof tokenHash !== 'string' || tokenHash.trim() === '') {
    return { isValid: false, error: 'MISSING_TOKEN_HASH' };
  }

  if (!type || typeof type !== 'string' || type.trim() === '') {
    return { isValid: false, error: 'MISSING_TYPE' };
  }

  if (type !== 'invite') {
    return { isValid: false, error: 'INVALID_TYPE' };
  }

  const safeNext = validateNextPath(next);

  return {
    isValid: true,
    data: {
      tokenHash: tokenHash.trim(),
      type: 'invite',
      next: safeNext
    }
  };
}

/**
 * Validates password updates.
 */
export function validatePasswordUpdate(params: {
  password: string | null | undefined;
  confirmation: string | null | undefined;
}): ValidationResult<string> {
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
    isValid: true,
    data: password
  };
}
