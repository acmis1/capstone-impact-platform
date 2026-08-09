/**
 * Validation result for folder-derived public ID.
 */
export interface PublicIdValidationResult {
  valid: boolean;
  message?: string;
}

const PUBLIC_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate provisional public ID derived from folder name.
 * Rule: Lowercase alphanumeric with hyphens, 1-100 characters.
 */
export function validateFolderDerivedPublicId(publicId: string): PublicIdValidationResult {
  if (!publicId || typeof publicId !== 'string') {
    return {
      valid: false,
      message: 'Folder-derived public ID is required and cannot be empty.',
    };
  }

  if (publicId.length < 1 || publicId.length > 100) {
    return {
      valid: false,
      message: 'Folder-derived public ID length must be between 1 and 100 characters.',
    };
  }

  if (!PUBLIC_ID_REGEX.test(publicId)) {
    return {
      valid: false,
      message: 'Folder-derived public ID is invalid. Public ID must contain only lowercase alphanumeric characters and single hyphens.',
    };
  }

  return { valid: true };
}
