const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_ID_REGEX = /^[a-zA-Z0-9\-_]+$/;

export type SubmitForReviewValidationResult =
  | {
      valid: true;
      data: {
        batchId: string;
        projectPublicIds: string[];
        comments: string | undefined;
      };
    }
  | {
      valid: false;
      error: string;
    };

/**
 * Pure validation utility for import batch review-submission request payloads.
 *
 * Rules:
 * - batchId route param must be a valid UUID.
 * - Request body must be a plain non-null JSON object (no arrays or primitives).
 * - projectPublicIds must be a non-empty array of at most 25 safe public-id-shaped strings,
 *   each restricted to alphanumeric/hyphen/underscore characters, max 100 chars, and unique
 *   after trimming (duplicates are rejected at this boundary; database-side deduplication in
 *   the RPC remains as defense-in-depth, not the sole authority).
 * - comments is optional; when provided, must be a string, trimmed, capped at 4000 chars,
 *   and empty trimmed comments are normalized to undefined.
 */
export function validateSubmitForReviewInput(body: unknown, batchIdParam: unknown): SubmitForReviewValidationResult {
  if (typeof batchIdParam !== 'string' || !UUID_REGEX.test(batchIdParam)) {
    return { valid: false, error: 'Batch ID must be a valid UUID.' };
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Request body must be a plain JSON object.' };
  }

  const payload = body as Record<string, unknown>;

  const rawIds = payload.projectPublicIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 25) {
    return { valid: false, error: 'projectPublicIds must be a non-empty array of at most 25 identifiers.' };
  }

  const projectPublicIds: string[] = [];
  const seenPublicIds = new Set<string>();
  for (const raw of rawIds) {
    if (typeof raw !== 'string') {
      return { valid: false, error: 'Each project public ID must be a string.' };
    }
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.length > 100 || !PUBLIC_ID_REGEX.test(trimmed)) {
      return { valid: false, error: 'Invalid project public ID.' };
    }
    if (seenPublicIds.has(trimmed)) {
      return { valid: false, error: 'Duplicate project public ID in request.' };
    }
    seenPublicIds.add(trimmed);
    projectPublicIds.push(trimmed);
  }

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

  return {
    valid: true,
    data: {
      batchId: batchIdParam,
      projectPublicIds,
      comments,
    },
  };
}
