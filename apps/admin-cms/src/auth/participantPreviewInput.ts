export type PublicIdValidationResult =
  | { valid: true; publicId: string }
  | { valid: false; error: string };

/**
 * Pure validation utility for the project public_id route parameter shared by the
 * participant-preview generate/revoke admin routes. Rules mirror validateReviewActionInput's
 * publicId handling: non-empty, max 100 chars, safe alphanumeric/hyphen/underscore only.
 */
export function validatePreviewPublicId(publicIdParam: unknown): PublicIdValidationResult {
  if (typeof publicIdParam !== 'string') {
    return { valid: false, error: 'Public ID must be a string.' };
  }

  const publicId = publicIdParam.trim();
  if (publicId === '') {
    return { valid: false, error: 'Public ID cannot be empty.' };
  }

  if (publicId.length > 100) {
    return { valid: false, error: 'Public ID exceeds maximum length of 100 characters.' };
  }

  const safePattern = /^[a-zA-Z0-9\-_]+$/;
  if (!safePattern.test(publicId)) {
    return { valid: false, error: 'Public ID contains illegal characters.' };
  }

  return { valid: true, publicId };
}
