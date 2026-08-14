import { createHash } from 'crypto';

/**
 * Media-stage-specific limits. Metadata (xlsx/json) limits continue to live in
 * BROWSER_IMPORT_LIMITS; these bound the additional binary media payload.
 */
export const BROWSER_IMPORT_MEDIA_LIMITS = {
  MAX_MEDIA_FILES: 75, // 25 packages * 3 recognized media files per package
  MAX_MEDIA_MULTIPART_REQUEST_BYTES: 150 * 1024 * 1024, // 150 MB ceiling for a single media-stage request
} as const;

export type BrowserImportMediaStageErrorCode =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'AUTH_SERVICE_UNAVAILABLE'
  | 'CROSS_ORIGIN_REJECTED'
  | 'MISSING_CONTENT_LENGTH'
  | 'INVALID_CONTENT_LENGTH'
  | 'REQUEST_TOO_LARGE'
  | 'MISSING_BATCH_ID'
  | 'DUPLICATE_BATCH_ID'
  | 'INVALID_BATCH_ID'
  | 'INVALID_MANIFEST'
  | 'INVALID_INTENT'
  | 'DUPLICATE_MANIFEST'
  | 'DUPLICATE_INTENT'
  | 'UNEXPECTED_UPLOAD_FIELD'
  | 'DUPLICATE_UPLOAD_FIELD'
  | 'MISSING_METADATA_UPLOAD'
  | 'METADATA_SIZE_MISMATCH'
  | 'MISSING_MEDIA_UPLOAD'
  | 'MEDIA_SIZE_MISMATCH'
  | 'MEDIA_SIGNATURE_MISMATCH'
  | 'MEDIA_UNSUPPORTED_TYPE'
  | 'PREVIEW_FINGERPRINT_MISMATCH'
  | 'INVALID_SELECTION'
  | 'BATCH_NOT_FOUND'
  | 'BATCH_INTENT_MISMATCH'
  | 'INVALID_BATCH_STATE'
  | 'BATCH_ALREADY_COMPLETED_MISMATCH'
  | 'STORAGE_UPLOAD_FAILED'
  | 'STORAGE_CONFLICT'
  | 'PERSISTENCE_FAILED'
  | 'UNEXPECTED_INTERNAL_ERROR';

export interface BrowserImportMediaStageSuccess {
  success: true;
  result: 'completed' | 'already_completed';
  batchId: string;
  mediaAssetCount: number;
  batchStatus: 'completed';
}

export interface BrowserImportMediaStageFailure {
  success: false;
  code: BrowserImportMediaStageErrorCode;
  error: string;
}

export type BrowserImportMediaStageResponse =
  | BrowserImportMediaStageSuccess
  | BrowserImportMediaStageFailure;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALLOWED_MEDIA_STAGE_ERROR_CODES = new Set<BrowserImportMediaStageErrorCode>([
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'AUTH_SERVICE_UNAVAILABLE',
  'CROSS_ORIGIN_REJECTED',
  'MISSING_CONTENT_LENGTH',
  'INVALID_CONTENT_LENGTH',
  'REQUEST_TOO_LARGE',
  'MISSING_BATCH_ID',
  'DUPLICATE_BATCH_ID',
  'INVALID_BATCH_ID',
  'INVALID_MANIFEST',
  'INVALID_INTENT',
  'DUPLICATE_MANIFEST',
  'DUPLICATE_INTENT',
  'UNEXPECTED_UPLOAD_FIELD',
  'DUPLICATE_UPLOAD_FIELD',
  'MISSING_METADATA_UPLOAD',
  'METADATA_SIZE_MISMATCH',
  'MISSING_MEDIA_UPLOAD',
  'MEDIA_SIZE_MISMATCH',
  'MEDIA_SIGNATURE_MISMATCH',
  'MEDIA_UNSUPPORTED_TYPE',
  'PREVIEW_FINGERPRINT_MISMATCH',
  'INVALID_SELECTION',
  'BATCH_NOT_FOUND',
  'BATCH_INTENT_MISMATCH',
  'INVALID_BATCH_STATE',
  'BATCH_ALREADY_COMPLETED_MISMATCH',
  'STORAGE_UPLOAD_FAILED',
  'STORAGE_CONFLICT',
  'PERSISTENCE_FAILED',
  'UNEXPECTED_INTERNAL_ERROR',
]);

const ALLOWED_SUCCESS_KEYS = new Set(['success', 'result', 'batchId', 'mediaAssetCount', 'batchStatus']);
const ALLOWED_FAILURE_KEYS = new Set(['success', 'code', 'error']);

export function validateBrowserImportMediaStageResponse(data: unknown): BrowserImportMediaStageResponse | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (obj.success === true) {
    if (!keys.every((k) => ALLOWED_SUCCESS_KEYS.has(k))) return null;
    if (
      (obj.result === 'completed' || obj.result === 'already_completed') &&
      typeof obj.batchId === 'string' &&
      UUID_REGEX.test(obj.batchId) &&
      typeof obj.mediaAssetCount === 'number' &&
      Number.isInteger(obj.mediaAssetCount) &&
      obj.mediaAssetCount >= 0 &&
      obj.batchStatus === 'completed'
    ) {
      return {
        success: true,
        result: obj.result,
        batchId: obj.batchId,
        mediaAssetCount: obj.mediaAssetCount,
        batchStatus: 'completed',
      };
    }
    return null;
  }

  if (obj.success === false) {
    if (!keys.every((k) => ALLOWED_FAILURE_KEYS.has(k))) return null;
    if (
      typeof obj.code === 'string' &&
      ALLOWED_MEDIA_STAGE_ERROR_CODES.has(obj.code as BrowserImportMediaStageErrorCode) &&
      typeof obj.error === 'string' &&
      obj.error.trim() !== '' &&
      obj.error.length <= 500
    ) {
      return {
        success: false,
        code: obj.code as BrowserImportMediaStageErrorCode,
        error: obj.error,
      };
    }
    return null;
  }

  return null;
}

export interface CanonicalExpectedMediaFile {
  packagePath: string;
  projectPublicId: string;
  assetType: string;
  fileName: string;
  fileSizeBytes: number;
  /**
   * Authoritative snapshot alt text for this file, or null when it has none. Part of the canonical
   * intent, not display metadata — see the binding note on `computeCanonicalMediaIntentHash`.
   */
  snapshotAltText?: string | null;
}

/**
 * Computes a deterministic SHA-256 hash binding a media-stage attempt to a specific batch,
 * the metadata intent it was staged from, and the exact expected media file set. Reproducing
 * this hash requires resubmitting the identical manifest/intent/batch that produced it, which
 * is what allows exact retries to converge and prevents attaching unrelated files to a batch.
 *
 * The snapshot alt text is part of that canonical set. Because the value is re-derived server-side
 * from the resubmitted package on every attempt, changing it changes this hash, so an alt text can
 * never be smuggled into an already-completed batch under an older intent — the mismatch is
 * rejected exactly like any other change to the expected media set.
 */
export function computeCanonicalMediaIntentHash(params: {
  batchId: string;
  metadataIntentHash: string;
  files: CanonicalExpectedMediaFile[];
}): string {
  const sortedFiles = [...params.files]
    .sort((a, b) => a.packagePath.localeCompare(b.packagePath) || a.assetType.localeCompare(b.assetType))
    .map((f) => ({
      packagePath: f.packagePath,
      projectPublicId: f.projectPublicId,
      assetType: f.assetType,
      fileName: f.fileName,
      fileSizeBytes: f.fileSizeBytes,
      snapshotAltText: f.snapshotAltText ?? null,
    }));

  const canonicalObj = {
    batchId: params.batchId,
    metadataIntentHash: params.metadataIntentHash,
    files: sortedFiles,
  };

  return createHash('sha256').update(JSON.stringify(canonicalObj), 'utf8').digest('hex');
}
