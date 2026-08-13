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

/**
 * Field names a browser must never be able to put on this endpoint.
 *
 * The recipient, the acting staff member and the preview credential are all resolved server-side
 * from trusted state. Silently ignoring these keys would be adequate for security, but rejecting
 * them outright is better: a caller that believed it was choosing a destination or an actor learns
 * immediately that it was not, instead of watching mail go somewhere else.
 */
const FORBIDDEN_REQUEST_FIELDS = [
  // Destination selection.
  'recipientEmail', 'recipient', 'participantContactEmail', 'to', 'cc', 'bcc', 'email',
  // Actor attribution.
  'adminId', 'actorId', 'requestedBy', 'role', 'permissions',
  // Preview credential / link.
  'previewToken', 'token', 'tokenHash', 'previewUrl', 'previewId', 'notificationId',
  'executionToken',
] as const;

export type ParticipantPreviewRequestBody =
  | { valid: true; isCorrectionReissue: boolean; sendEmail: boolean }
  | { valid: false };

/**
 * Parses the optional participant-preview POST body. Only two intent flags are accepted; anything
 * that looks like an attempt to supply authoritative data is rejected before any state change.
 * An absent, empty or non-JSON body is the ordinary Generate Without Email case and stays valid.
 */
export function parseParticipantPreviewRequestBody(body: unknown): ParticipantPreviewRequestBody {
  if (body === undefined || body === null) {
    return { valid: true, isCorrectionReissue: false, sendEmail: false };
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false };
  }

  const record = body as Record<string, unknown>;

  for (const field of FORBIDDEN_REQUEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      return { valid: false };
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'isCorrectionReissue' && key !== 'sendEmail') {
      return { valid: false };
    }
    if (typeof value !== 'boolean') {
      return { valid: false };
    }
  }

  return {
    valid: true,
    isCorrectionReissue: record.isCorrectionReissue === true,
    sendEmail: record.sendEmail === true,
  };
}
