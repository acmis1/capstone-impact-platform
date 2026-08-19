/** Pure password validation retained for the invitation password-establishment flow. */

// Compatibility exports keep existing invitation imports stable while generic confirmation
// routing lives in the accurately named confirmationValidation module.
export {
  INVITATION_COOKIE_NAME,
  INVITATION_COOKIE_PATH,
  INVITATION_COOKIE_MAX_AGE_SECONDS,
  INVITATION_ACCEPT_PATH,
  INVITATION_PASSWORD_PATH,
  validateNextPath,
  validateConfirmationParams,
} from './confirmationValidation';

export interface ValidationResult {
  isValid: boolean;
  error?: string;
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
