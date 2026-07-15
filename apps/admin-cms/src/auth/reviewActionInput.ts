export type ValidationResult =
  | {
      valid: true;
      data: {
        action: 'request_changes' | 'approve' | 'archive';
        comments: string | undefined;
        publicId: string;
      };
    }
  | {
      valid: false;
      error: string;
    };

/**
 * Pure validation utility for project review action payloads.
 * 
 * Rules:
 * - Request body must be a plain non-null JSON object (no arrays or primitives).
 * - Action parameter must be exactly 'request_changes', 'approve', or 'archive'.
 * - Comments is optional; when provided, must be a string, trimmed, capped at 4000 chars,
 *   and empty trimmed comments are normalized to undefined. Reject null, numbers, booleans, arrays, objects.
 * - publicId must be non-empty, max 100 chars, and restricted to safe alphanumeric/hyphen/underscore patterns.
 */
export function validateReviewActionInput(body: unknown, publicIdParam: unknown): ValidationResult {
  // 1. Validate request body type
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Request body must be a plain JSON object.' };
  }

  const payload = body as Record<string, unknown>;

  // 2. Validate action
  const action = payload.action;
  if (typeof action !== 'string' || !['request_changes', 'approve', 'archive'].includes(action)) {
    return { valid: false, error: 'Invalid or missing action parameter.' };
  }

  // 3. Validate comments
  let comments: string | undefined = undefined;
  if ('comments' in payload) {
    const rawComments = payload.comments;
    if (rawComments === null) {
      return { valid: false, error: 'Comments parameter must be a string when provided.' };
    }
    if (rawComments !== undefined) {
      if (typeof rawComments !== 'string') {
        return { valid: false, error: 'Comments parameter must be a string.' };
      }
      const trimmed = rawComments.trim();
      if (trimmed.length > 4000) {
        return { valid: false, error: 'Comments exceed the maximum length of 4000 characters.' };
      }
      comments = trimmed === '' ? undefined : trimmed;
    }
  }

  // 4. Validate publicId
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

  // Prevent SQL / path injection via alphanumeric/hyphen/underscore pattern constraint
  const safePattern = /^[a-zA-Z0-9\-_]+$/;
  if (!safePattern.test(publicId)) {
    return { valid: false, error: 'Public ID contains illegal characters.' };
  }

  return {
    valid: true,
    data: {
      action: action as 'request_changes' | 'approve' | 'archive',
      comments,
      publicId,
    },
  };
}
