import {
  BULK_ASSISTIVE_MAX_SELECTION,
  isSafeBulkAssistivePublicId,
  isAssistiveInputHash,
  type BulkAssistiveExecutionInput,
  type BulkAssistivePreflightInput,
} from '../assistive-validation/domain/bulkExecutionContract';

export type BulkAssistiveInputResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePublicIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > BULK_ASSISTIVE_MAX_SELECTION) return null;
  if (!value.every((id) => isSafeBulkAssistivePublicId(id))) return null;
  const ids = value.map((id) => id.trim());
  return [...new Set(ids)];
}

export function validateBulkAssistivePreflightInput(body: unknown): BulkAssistiveInputResult<BulkAssistivePreflightInput> {
  if (!isPlainObject(body)) return { valid: false, error: 'Validation failed.' };
  const publicIds = validatePublicIds(body.publicIds);
  if (!publicIds) return { valid: false, error: 'Validation failed.' };
  return { valid: true, data: { publicIds } };
}

export function validateBulkAssistiveExecuteInput(body: unknown): BulkAssistiveInputResult<BulkAssistiveExecutionInput> {
  if (!isPlainObject(body)) return { valid: false, error: 'Validation failed.' };
  const publicIds = validatePublicIds(body.publicIds);
  if (!publicIds || !isPlainObject(body.expectedInputHashes)) {
    return { valid: false, error: 'Validation failed.' };
  }

  const expectedInputHashes: Record<string, string | null> = {};
  for (const publicId of publicIds) {
    const value = body.expectedInputHashes[publicId];
    if (value !== null && !isAssistiveInputHash(value)) {
      return { valid: false, error: 'Validation failed.' };
    }
    expectedInputHashes[publicId] = value as string | null;
  }

  return { valid: true, data: { publicIds, expectedInputHashes } };
}
