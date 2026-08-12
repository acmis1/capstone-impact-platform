export const MAX_CORRECTION_COMMENT_LENGTH = 2000;

export type CorrectionCommentValidationResult =
  | { valid: true; comment: string }
  | { valid: false };

/**
 * Pure normalization/validation for a participant-authored correction comment: trims leading/
 * trailing whitespace, rejects empty/whitespace-only input, and enforces the maximum length bound.
 * Mirrors (and is independently re-checked by) the Migration 0015
 * request_participant_preview_correction RPC's own trim/length validation at the database
 * boundary — this is the server-side (Next.js route) layer of that same two-layer validation.
 */
export function validateCorrectionComment(candidate: unknown): CorrectionCommentValidationResult {
  if (typeof candidate !== 'string') {
    return { valid: false };
  }

  const comment = candidate.trim();
  if (comment === '' || comment.length > MAX_CORRECTION_COMMENT_LENGTH) {
    return { valid: false };
  }

  return { valid: true, comment };
}
