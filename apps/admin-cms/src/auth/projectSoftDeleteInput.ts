import { isSafeBulkPublicId } from '../projects/bulkProjectReview';
import { SOFT_DELETE_MAX_SELECTION } from '../projects/projectSoftDelete';

type Invalid = { valid: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(body).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function validateSoftDeletePreflightInput(
  body: unknown,
): Invalid | { valid: true; data: { publicIds: string[] } } {
  if (!isPlainObject(body) || !exactKeys(body, ['publicIds']) || !Array.isArray(body.publicIds)) {
    return { valid: false };
  }
  const publicIds = body.publicIds;
  if (publicIds.length < 1 || publicIds.length > SOFT_DELETE_MAX_SELECTION) return { valid: false };
  if (!publicIds.every(isSafeBulkPublicId)) return { valid: false };
  if (new Set(publicIds).size !== publicIds.length) return { valid: false };
  return { valid: true, data: { publicIds: [...publicIds] } };
}

export function validateSoftDeleteExecutionInput(
  body: unknown,
  publicId: unknown,
): Invalid | { valid: true; data: { publicId: string; expectedUpdatedAt: string } } {
  if (!isSafeBulkPublicId(publicId) || !isPlainObject(body) || !exactKeys(body, ['expectedUpdatedAt'])) {
    return { valid: false };
  }
  const expectedUpdatedAt = body.expectedUpdatedAt;
  if (
    typeof expectedUpdatedAt !== 'string'
    || expectedUpdatedAt.length < 1
    || expectedUpdatedAt.length > 100
    || !Number.isFinite(Date.parse(expectedUpdatedAt))
  ) {
    return { valid: false };
  }
  return { valid: true, data: { publicId, expectedUpdatedAt } };
}
