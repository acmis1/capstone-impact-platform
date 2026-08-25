import {
  BULK_REVIEW_MAX_COMMENT_LENGTH,
  BULK_REVIEW_MAX_PUBLIC_ID_LENGTH,
  BULK_REVIEW_MAX_SELECTION,
  BulkReviewAction,
  isBulkReviewAction,
  isSafeBulkPublicId,
} from '../projects/bulkProjectReview';

export interface BulkReviewPreflightInput {
  action: BulkReviewAction;
  publicIds: string[];
}

export interface BulkReviewExecuteInput extends BulkReviewPreflightInput {
  expectedUpdatedAt: Record<string, string | null>;
  comments?: string;
}

export type BulkReviewInputResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

function validatePublicIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > BULK_REVIEW_MAX_SELECTION) return null;
  if (!value.every((id) => isSafeBulkPublicId(id) && id.length <= BULK_REVIEW_MAX_PUBLIC_ID_LENGTH)) return null;
  const ids = value.map((id) => id.trim());
  return new Set(ids).size === ids.length ? ids : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateBulkReviewPreflightInput(body: unknown): BulkReviewInputResult<BulkReviewPreflightInput> {
  if (!isPlainObject(body) || !isBulkReviewAction(body.action)) {
    return { valid: false, error: 'Validation failed.' };
  }
  const publicIds = validatePublicIds(body.publicIds);
  if (!publicIds) return { valid: false, error: 'Validation failed.' };
  return { valid: true, data: { action: body.action, publicIds } };
}

export function validateBulkReviewExecuteInput(body: unknown): BulkReviewInputResult<BulkReviewExecuteInput> {
  if (!isPlainObject(body) || !isBulkReviewAction(body.action)) {
    return { valid: false, error: 'Validation failed.' };
  }
  const publicIds = validatePublicIds(body.publicIds);
  if (!publicIds || !isPlainObject(body.expectedUpdatedAt)) {
    return { valid: false, error: 'Validation failed.' };
  }

  const expectedUpdatedAt: Record<string, string | null> = {};
  for (const publicId of publicIds) {
    const value = body.expectedUpdatedAt[publicId];
    if (value !== null && (typeof value !== 'string' || value.length > 100)) {
      return { valid: false, error: 'Validation failed.' };
    }
    expectedUpdatedAt[publicId] = value as string | null;
  }

  let comments: string | undefined;
  if ('comments' in body) {
    if (body.comments !== undefined && typeof body.comments !== 'string') {
      return { valid: false, error: 'Validation failed.' };
    }
    if (typeof body.comments === 'string') {
      comments = body.comments.trim();
      if (comments.length > BULK_REVIEW_MAX_COMMENT_LENGTH) {
        return { valid: false, error: 'Validation failed.' };
      }
    }
  }

  if (body.action !== 'request_changes' && comments !== undefined) {
    return { valid: false, error: 'Validation failed.' };
  }

  if (body.action === 'request_changes' && !comments) {
    return { valid: false, error: 'Validation failed.' };
  }

  return { valid: true, data: { action: body.action, publicIds, expectedUpdatedAt, comments } };
}
