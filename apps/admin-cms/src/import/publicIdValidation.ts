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

  const trimmed = publicId.trim();

  if (trimmed.length < 1 || trimmed.length > 100) {
    return {
      valid: false,
      message: `Folder-derived public ID length must be between 1 and 100 characters (received ${trimmed.length}).`,
    };
  }

  if (!PUBLIC_ID_REGEX.test(trimmed)) {
    return {
      valid: false,
      message: `Folder-derived public ID "${trimmed}" is invalid. Public ID must contain only lowercase alphanumeric characters and single hyphens.`,
    };
  }

  return { valid: true };
}
