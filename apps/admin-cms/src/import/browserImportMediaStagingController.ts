import {
  generateUploadKey,
  isIgnoredSystemFile,
  normalizeRelativePath,
} from './browserSelection';
import { SelectionManifest } from './browserImportPreviewContract';
import { BrowserImportCommitIntent } from './browserImportCommitIntentContract';
import {
  BrowserImportMediaStageErrorCode,
  BrowserImportMediaStageResponse,
  validateBrowserImportMediaStageResponse,
} from './browserImportMediaStageContract';

export interface BrowserImportMediaStagingLock {
  current: boolean;
}

export interface RunBrowserImportMediaStagingParams {
  lock: BrowserImportMediaStagingLock;
  isCompletingMedia: boolean;
  batchId: string | null;
  preparedIntent: BrowserImportCommitIntent | null;
  manifestCache: SelectionManifest | null;
  selectedPackagePaths: string[];
  selectedFiles: File[];
  setIsCompletingMedia: (val: boolean) => void;
  setMediaCompleteError: (error: string | null) => void;
  setMediaCompleteResult: (result: {
    batchId: string;
    mediaAssetCount: number;
    result: 'completed' | 'already_completed';
  }) => void;
  fetchFn?: typeof fetch;
}

export const MEDIA_STAGING_KNOWN_ERROR_MAP: Record<string, string> = {
  UNAUTHENTICATED: 'Authentication required. Please log in with staff credentials.',
  PERMISSION_DENIED: 'Access denied: You do not have permission to complete imports.',
  AUTH_SERVICE_UNAVAILABLE: 'Authentication service is temporarily unavailable.',
  CROSS_ORIGIN_REJECTED: 'Cross-origin requests are forbidden.',
  MISSING_CONTENT_LENGTH: 'Request Content-Length is missing or invalid.',
  INVALID_CONTENT_LENGTH: 'Request Content-Length is invalid.',
  REQUEST_TOO_LARGE: 'Request size exceeds maximum limit.',
  MISSING_BATCH_ID: 'The import batch could not be identified.',
  DUPLICATE_BATCH_ID: 'Duplicate batch identifier is forbidden.',
  INVALID_BATCH_ID: 'The import batch identifier was invalid.',
  INVALID_MANIFEST: 'Selection manifest is invalid or malformed.',
  INVALID_INTENT: 'Prepared intent is invalid or malformed.',
  DUPLICATE_MANIFEST: 'Duplicate manifest field is forbidden.',
  DUPLICATE_INTENT: 'Duplicate intent field is forbidden.',
  UNEXPECTED_UPLOAD_FIELD: 'Form contains unrecognized upload fields.',
  DUPLICATE_UPLOAD_FIELD: 'Form contains duplicate upload fields.',
  MISSING_METADATA_UPLOAD: 'Missing expected metadata file upload.',
  METADATA_SIZE_MISMATCH: 'Uploaded metadata file size mismatch.',
  MISSING_MEDIA_UPLOAD: 'Missing an expected media file. Re-select the original folder and try again.',
  MEDIA_SIZE_MISMATCH: 'Uploaded media file size mismatch. Re-select the original folder and try again.',
  MEDIA_SIGNATURE_MISMATCH: 'Uploaded media file content did not match its expected type.',
  MEDIA_UNSUPPORTED_TYPE: 'Uploaded media file type is not supported.',
  PREVIEW_FINGERPRINT_MISMATCH: 'Preview state has changed or fingerprint does not match. Re-select the folder and try again.',
  INVALID_SELECTION: 'Selected packages are invalid or not allowed.',
  BATCH_NOT_FOUND: 'The import batch could not be found.',
  BATCH_INTENT_MISMATCH: 'The import batch could not be verified for this request.',
  INVALID_BATCH_STATE: 'The import batch is not in a state that allows media staging.',
  BATCH_ALREADY_COMPLETED_MISMATCH: 'The import batch was already completed with a different media selection.',
  STORAGE_UPLOAD_FAILED: 'A media file could not be uploaded. Please try again.',
  STORAGE_CONFLICT: 'A media storage conflict was detected. Please try again.',
  PERSISTENCE_FAILED: 'The media staging operation could not be saved.',
  UNEXPECTED_INTERNAL_ERROR: 'The import could not be completed. Please try again.',
};

/**
 * Submits the original in-memory browser folder files for media staging and import completion.
 * Only poster/PDF/snapshot files belonging to the currently selected packages are attached;
 * metadata files are resent for all packages so the server can independently re-derive state,
 * exactly mirroring the metadata-staging submission pattern.
 */
export async function runBrowserImportMediaStaging(
  params: RunBrowserImportMediaStagingParams
): Promise<BrowserImportMediaStageResponse | null> {
  const {
    lock,
    isCompletingMedia,
    batchId,
    preparedIntent,
    manifestCache,
    selectedPackagePaths,
    selectedFiles,
    setIsCompletingMedia,
    setMediaCompleteError,
    setMediaCompleteResult,
    fetchFn = fetch,
  } = params;

  if (!preparedIntent || !manifestCache || !batchId || lock.current || isCompletingMedia) {
    return null;
  }

  lock.current = true;
  setIsCompletingMedia(true);
  setMediaCompleteError(null);

  try {
    const selectedPackageSet = new Set(selectedPackagePaths);
    const formData = new FormData();
    formData.append('batchId', batchId);
    formData.append('manifest', JSON.stringify(manifestCache));
    formData.append('intent', JSON.stringify(preparedIntent));

    for (const file of selectedFiles) {
      const relPath = file.webkitRelativePath || file.name;
      const norm = normalizeRelativePath(relPath);
      if (!norm || isIgnoredSystemFile(norm)) continue;
      const parts = norm.split('/');
      const lowerName = parts[parts.length - 1].toLowerCase();
      const packagePath = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];

      if (lowerName === 'project-details.xlsx' || lowerName === 'project.json') {
        const key = generateUploadKey(norm);
        formData.append(key, file);
      } else if (
        (lowerName === 'poster.png' || lowerName === 'poster.pdf' || lowerName === 'snapshot-1.png') &&
        selectedPackageSet.has(packagePath)
      ) {
        const key = generateUploadKey(norm);
        formData.append(key, file);
      }
    }

    const res = await fetchFn('/api/imports/stage-media', {
      method: 'POST',
      body: formData,
    });

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      const errMsg = MEDIA_STAGING_KNOWN_ERROR_MAP.UNEXPECTED_INTERNAL_ERROR;
      setMediaCompleteError(errMsg);
      return { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: errMsg };
    }

    const validatedResponse = validateBrowserImportMediaStageResponse(json);

    if (!res.ok || !validatedResponse || !validatedResponse.success) {
      const errObj = json as { code?: string; error?: string };
      const codeStr = errObj && typeof errObj.code === 'string' ? errObj.code : 'UNEXPECTED_INTERNAL_ERROR';
      const msg = MEDIA_STAGING_KNOWN_ERROR_MAP[codeStr] || MEDIA_STAGING_KNOWN_ERROR_MAP.UNEXPECTED_INTERNAL_ERROR;
      setMediaCompleteError(msg);
      return validatedResponse && !validatedResponse.success
        ? validatedResponse
        : { success: false, code: codeStr as BrowserImportMediaStageErrorCode, error: msg };
    }

    setMediaCompleteResult({
      batchId: validatedResponse.batchId,
      mediaAssetCount: validatedResponse.mediaAssetCount,
      result: validatedResponse.result,
    });

    return validatedResponse;
  } catch {
    const msg = MEDIA_STAGING_KNOWN_ERROR_MAP.UNEXPECTED_INTERNAL_ERROR;
    setMediaCompleteError(msg);
    return { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: msg };
  } finally {
    setIsCompletingMedia(false);
    lock.current = false;
  }
}
