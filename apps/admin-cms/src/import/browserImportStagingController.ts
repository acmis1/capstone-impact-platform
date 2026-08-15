import {
  generateUploadKey,
  isIgnoredSystemFile,
  normalizeRelativePath,
} from './browserSelection';
import type { SelectionManifest } from './browserImportPreviewContract';
import type { BrowserImportCommitIntent } from './browserImportCommitIntentContract';
import {
  validateBrowserImportMetadataStageResponse,
} from './browserImportMetadataStageContract';
import type {
  BrowserImportMetadataStageErrorCode,
  BrowserImportMetadataStageResponse,
} from './browserImportMetadataStageContract';
import type { AdminReferenceMappingConfig } from './adminReferenceSharedContract';

export interface BrowserImportStagingLock {
  current: boolean;
}

export interface RunBrowserImportMetadataStagingParams {
  lock: BrowserImportStagingLock;
  isStaging: boolean;
  preparedIntent: BrowserImportCommitIntent | null;
  manifestCache: SelectionManifest | null;
  selectedFiles: File[];
  adminReferenceFile?: File | null;
  adminReferenceMappingConfig?: AdminReferenceMappingConfig | null;
  setIsStaging: (val: boolean) => void;
  setStagingError: (error: string | null) => void;
  setStagedResult: (result: {
    batchId: string;
    projectCount: number;
    warningCount: number;
    result: 'created' | 'already_staged';
  }) => void;
  fetchFn?: typeof fetch;
}

export const STAGING_KNOWN_ERROR_MAP: Record<string, string> = {
  UNAUTHENTICATED: 'Authentication required. Please log in with staff credentials.',
  PERMISSION_DENIED: 'Access denied: You do not have permission to stage imports.',
  AUTH_SERVICE_UNAVAILABLE: 'Authentication service is temporarily unavailable.',
  CROSS_ORIGIN_REJECTED: 'Cross-origin requests are forbidden.',
  MISSING_CONTENT_LENGTH: 'Request Content-Length is missing or invalid.',
  INVALID_CONTENT_LENGTH: 'Request Content-Length is invalid.',
  REQUEST_TOO_LARGE: 'Request size exceeds maximum limit.',
  INVALID_MANIFEST: 'Selection manifest is invalid or malformed.',
  INVALID_INTENT: 'Prepared intent is invalid or malformed.',
  DUPLICATE_MANIFEST: 'Duplicate manifest field is forbidden.',
  DUPLICATE_INTENT: 'Duplicate intent field is forbidden.',
  UNEXPECTED_UPLOAD_FIELD: 'Form contains unrecognized upload fields.',
  DUPLICATE_UPLOAD_FIELD: 'Form contains duplicate upload fields.',
  MISSING_METADATA_UPLOAD: 'Missing expected metadata file upload.',
  METADATA_SIZE_MISMATCH: 'Uploaded metadata file size mismatch.',
  PREVIEW_FINGERPRINT_MISMATCH: 'Preview state has changed or fingerprint does not match.',
  INVALID_SELECTION: 'Selected packages are invalid or not allowed.',
  LOOKUP_NOT_FOUND: 'Required program, discipline, or category lookup could not be found.',
  PROJECT_ALREADY_EXISTS: 'One or more selected project public IDs already exist in the database.',
  PERSISTENCE_FAILED: 'The metadata staging operation could not be saved.',
  UNEXPECTED_INTERNAL_ERROR: 'The metadata staging operation could not be completed. Please try again.',
};

export async function runBrowserImportMetadataStaging(
  params: RunBrowserImportMetadataStagingParams
): Promise<BrowserImportMetadataStageResponse | null> {
  const {
    lock,
    isStaging,
    preparedIntent,
    manifestCache,
    selectedFiles,
    adminReferenceFile,
    adminReferenceMappingConfig,
    setIsStaging,
    setStagingError,
    setStagedResult,
    fetchFn = fetch,
  } = params;

  if (!preparedIntent || !manifestCache || lock.current || isStaging) {
    return null;
  }

  lock.current = true;
  setIsStaging(true);
  setStagingError(null);

  try {
    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifestCache));
    formData.append('intent', JSON.stringify(preparedIntent));

    if (adminReferenceFile && adminReferenceMappingConfig) {
      formData.append('referenceFile', adminReferenceFile);
      formData.append('adminReferenceMapping', JSON.stringify(adminReferenceMappingConfig));
    }

    // Filter and attach ONLY metadata files (project-details.xlsx or project.json).
    // Poster/PDF/snapshot asset files are strictly excluded from staging upload.
    for (const file of selectedFiles) {
      const relPath = file.webkitRelativePath || file.name;
      const norm = normalizeRelativePath(relPath);
      if (!norm || isIgnoredSystemFile(norm)) continue;
      const parts = norm.split('/');
      const lowerName = parts[parts.length - 1].toLowerCase();
      if (lowerName === 'project-details.xlsx' || lowerName === 'project.json') {
        const key = generateUploadKey(norm);
        formData.append(key, file);
      }
    }

    const res = await fetchFn('/api/imports/stage-metadata', {
      method: 'POST',
      body: formData,
    });

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      const errMsg = STAGING_KNOWN_ERROR_MAP.UNEXPECTED_INTERNAL_ERROR;
      setStagingError(errMsg);
      return { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: errMsg };
    }

    const validatedResponse = validateBrowserImportMetadataStageResponse(json);

    if (!res.ok || !validatedResponse || !validatedResponse.success) {
      const errObj = json as { code?: string; error?: string };
      const codeStr = (errObj && typeof errObj.code === 'string') ? errObj.code : 'UNEXPECTED_INTERNAL_ERROR';
      const msg = STAGING_KNOWN_ERROR_MAP[codeStr] || STAGING_KNOWN_ERROR_MAP.UNEXPECTED_INTERNAL_ERROR;
      setStagingError(msg);
      return validatedResponse && !validatedResponse.success
        ? validatedResponse
        : { success: false, code: codeStr as BrowserImportMetadataStageErrorCode, error: msg };
    }

    setStagedResult({
      batchId: validatedResponse.batchId,
      projectCount: validatedResponse.projectCount,
      warningCount: validatedResponse.warningCount,
      result: validatedResponse.result,
    });

    return validatedResponse;
  } catch {
    const msg = STAGING_KNOWN_ERROR_MAP.UNEXPECTED_INTERNAL_ERROR;
    setStagingError(msg);
    return { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: msg };
  } finally {
    setIsStaging(false);
    lock.current = false;
  }
}
