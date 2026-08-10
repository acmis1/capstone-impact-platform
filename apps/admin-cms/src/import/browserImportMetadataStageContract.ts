import { createHash } from 'crypto';
import { BrowserImportCommitIntent } from './browserImportCommitIntentContract';

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

export function validateBrowserImportMetadataStageResponse(data: unknown): BrowserImportMetadataStageResponse | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;

  if (obj.success === true) {
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
    if (typeof obj.code === 'string' && typeof obj.error === 'string') {
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

/**
 * Computes a deterministic SHA-256 intent hash from the canonical BrowserImportCommitIntent.
 * Returns a lowercase 64-character hex string.
 */
export function computeCanonicalIntentHash(intent: BrowserImportCommitIntent): string {
  const canonicalObj = {
    version: intent.version,
    previewFingerprint: intent.previewFingerprint,
    selectedRootName: intent.selectedRootName,
    fileCount: intent.fileCount,
    declaredTotalBytes: intent.declaredTotalBytes,
    selectedPackagePaths: [...intent.selectedPackagePaths].sort((a, b) => a.localeCompare(b)),
    acknowledgedWarningPackagePaths: [...intent.acknowledgedWarningPackagePaths].sort((a, b) => a.localeCompare(b)),
  };

  return createHash('sha256').update(JSON.stringify(canonicalObj), 'utf8').digest('hex');
}
