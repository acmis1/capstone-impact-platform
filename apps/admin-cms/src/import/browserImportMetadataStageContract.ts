export type BrowserImportMetadataStageErrorCode =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'AUTH_SERVICE_UNAVAILABLE'
  | 'CROSS_ORIGIN_REJECTED'
  | 'MISSING_CONTENT_LENGTH'
  | 'INVALID_CONTENT_LENGTH'
  | 'REQUEST_TOO_LARGE'
  | 'INVALID_MANIFEST'
  | 'INVALID_INTENT'
  | 'DUPLICATE_MANIFEST'
  | 'DUPLICATE_INTENT'
  | 'UNEXPECTED_UPLOAD_FIELD'
  | 'DUPLICATE_UPLOAD_FIELD'
  | 'MISSING_METADATA_UPLOAD'
  | 'METADATA_SIZE_MISMATCH'
  | 'PREVIEW_FINGERPRINT_MISMATCH'
  | 'INVALID_SELECTION'
  | 'LOOKUP_NOT_FOUND'
  | 'PROJECT_ALREADY_EXISTS'
  | 'PERSISTENCE_FAILED'
  | 'UNEXPECTED_INTERNAL_ERROR';

export interface BrowserImportMetadataStageSuccess {
  success: true;
  result: 'created' | 'already_staged';
  batchId: string;
  projectCount: number;
  warningCount: number;
  batchStatus: 'metadata_staged';
}

export interface BrowserImportMetadataStageFailure {
  success: false;
  code: BrowserImportMetadataStageErrorCode;
  error: string;
}

export type BrowserImportMetadataStageResponse =
  | BrowserImportMetadataStageSuccess
  | BrowserImportMetadataStageFailure;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALLOWED_STAGE_ERROR_CODES = new Set<BrowserImportMetadataStageErrorCode>([
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'AUTH_SERVICE_UNAVAILABLE',
  'CROSS_ORIGIN_REJECTED',
  'MISSING_CONTENT_LENGTH',
  'INVALID_CONTENT_LENGTH',
  'REQUEST_TOO_LARGE',
  'INVALID_MANIFEST',
  'INVALID_INTENT',
  'DUPLICATE_MANIFEST',
  'DUPLICATE_INTENT',
  'UNEXPECTED_UPLOAD_FIELD',
  'DUPLICATE_UPLOAD_FIELD',
  'MISSING_METADATA_UPLOAD',
  'METADATA_SIZE_MISMATCH',
  'PREVIEW_FINGERPRINT_MISMATCH',
  'INVALID_SELECTION',
  'LOOKUP_NOT_FOUND',
  'PROJECT_ALREADY_EXISTS',
  'PERSISTENCE_FAILED',
  'UNEXPECTED_INTERNAL_ERROR',
]);

const ALLOWED_SUCCESS_KEYS = new Set(['success', 'result', 'batchId', 'projectCount', 'warningCount', 'batchStatus']);
const ALLOWED_FAILURE_KEYS = new Set(['success', 'code', 'error']);

export function validateBrowserImportMetadataStageResponse(data: unknown): BrowserImportMetadataStageResponse | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (obj.success === true) {
    if (!keys.every((k) => ALLOWED_SUCCESS_KEYS.has(k))) return null;
    if (
      (obj.result === 'created' || obj.result === 'already_staged') &&
      typeof obj.batchId === 'string' &&
      UUID_REGEX.test(obj.batchId) &&
      typeof obj.projectCount === 'number' &&
      Number.isInteger(obj.projectCount) &&
      obj.projectCount >= 0 &&
      typeof obj.warningCount === 'number' &&
      Number.isInteger(obj.warningCount) &&
      obj.warningCount >= 0 &&
      obj.batchStatus === 'metadata_staged'
    ) {
      return {
        success: true,
        result: obj.result,
        batchId: obj.batchId,
        projectCount: obj.projectCount,
        warningCount: obj.warningCount,
        batchStatus: 'metadata_staged',
      };
    }
    return null;
  }

  if (obj.success === false) {
    if (!keys.every((k) => ALLOWED_FAILURE_KEYS.has(k))) return null;
    if (
      typeof obj.code === 'string' &&
      ALLOWED_STAGE_ERROR_CODES.has(obj.code as BrowserImportMetadataStageErrorCode) &&
      typeof obj.error === 'string' &&
      obj.error.trim() !== '' &&
      obj.error.length <= 500
    ) {
      return {
        success: false,
        code: obj.code as BrowserImportMetadataStageErrorCode,
        error: obj.error,
      };
    }
    return null;
  }

  return null;
}
