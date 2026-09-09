import type { AdminReferenceMappingConfig } from './adminReferenceSharedContract';
import { prepareBrowserImportCommitIntentClient } from './prepareBrowserImportCommitIntentClient';
import { runBrowserImportMetadataStaging } from './browserImportStagingController';
import { runBrowserImportMediaStaging } from './browserImportMediaStagingController';
import type { BrowserImportCommitIntent } from './browserImportCommitIntentContract';
import type { BrowserImportPreviewBatch, SelectionManifest } from './browserImportPreviewContract';
import { generateUploadKey } from './browserSelection';
import {
  canResumeAnnualIntake,
  compareDeterministically,
  createAnnualIntakeCohortId,
  createInitialAnnualIntakeProgress,
  fingerprintAnnualIntakeChunk,
  formatAnnualIntakeSourceFolder,
  mergeAnnualIntakePreviews,
  partitionAnnualIntakeFiles,
  withAnnualIntakeInFlightLock,
  type AnnualIntakeChunkProgress,
  type AnnualIntakeFileChunk,
  type AnnualIntakeLockResult,
  type AnnualIntakeLockRunner,
  type AnnualIntakePreviewChunk,
  type AnnualIntakePreviewPlan,
  type AnnualIntakeProgress,
  type AnnualIntakeProgressStore,
} from './annualIntakeContract';
import { validateBrowserImportPreviewResponse } from './browserImportPreviewContract';

export interface AnnualIntakePreviewParams {
  selectedFiles: File[];
  selectedRootName: string;
  adminReferenceFile?: File | null;
  adminReferenceMappingConfig?: AdminReferenceMappingConfig | null;
  fetchFn?: typeof fetch;
  onProgress?: (progress: { completedChunks: number; totalChunks: number; packageCount: number }) => void;
}

export type AnnualIntakePreviewResult =
  | { success: true; plan: AnnualIntakePreviewPlan }
  | { success: false; code: string; error: string; failedChunkIndex: number };

const PREVIEW_ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Authentication required. Please log in with staff credentials.',
  PERMISSION_DENIED: 'Access denied: You do not have permission to preview imports.',
  AUTH_SERVICE_UNAVAILABLE: 'Authentication service is temporarily unavailable. Please try again.',
  CROSS_ORIGIN_REJECTED: 'Cross-origin requests are forbidden.',
  MISSING_CONTENT_LENGTH: 'A valid Content-Length header is required for this request.',
  INVALID_CONTENT_LENGTH: 'The preview request was invalid.',
  REQUEST_TOO_LARGE: 'The preview request exceeds the existing per-request limit.',
  INVALID_MANIFEST: 'The preview request was invalid.',
  DUPLICATE_MANIFEST: 'The preview request was invalid.',
  UNEXPECTED_UPLOAD_FIELD: 'The preview request was invalid.',
  DUPLICATE_UPLOAD_FIELD: 'The preview request was invalid.',
  MISSING_METADATA_UPLOAD: 'A metadata file was missing from the preview request.',
  METADATA_SIZE_MISMATCH: 'A metadata file size did not match its descriptor.',
  METADATA_LIMIT_EXCEEDED: 'The preview request exceeds the existing metadata limit.',
  PACKAGE_LIMIT_EXCEEDED: 'The preview chunk exceeds the existing 25-package limit.',
  CONTENT_FINGERPRINT_UNAVAILABLE: 'The selected files could not be verified securely. Please re-select the folder and try again.',
  UNEXPECTED_INTERNAL_ERROR: 'The preview request could not be completed. Please try again.',
};

function previewErrorMessage(code: string): string {
  return PREVIEW_ERROR_MESSAGES[code] || PREVIEW_ERROR_MESSAGES.UNEXPECTED_INTERNAL_ERROR;
}

function appendMetadataFiles(formData: FormData, files: File[], manifest: SelectionManifest): void {
  const expectedKeys = new Set(
    manifest.descriptors
      .filter((descriptor) => {
        const fileName = descriptor.originalPath.split('/').pop()?.toLowerCase();
        return fileName === 'project-details.xlsx' || fileName === 'project.json';
      })
      .map((descriptor) => descriptor.uploadKey),
  );

  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const normalizedPath = relPath.replace(/\\/g, '/');
    const key = generateUploadKey(normalizedPath);
    if (expectedKeys.has(key)) formData.append(key, file);
  }
}

async function requestPreviewChunk(params: {
  chunk: AnnualIntakeFileChunk;
  adminReferenceFile?: File | null;
  adminReferenceMappingConfig?: AdminReferenceMappingConfig | null;
  fetchFn: typeof fetch;
}): Promise<{ success: true; batch: BrowserImportPreviewBatch } | { success: false; code: string; error: string }> {
  const { chunk, adminReferenceFile, adminReferenceMappingConfig, fetchFn } = params;
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(chunk.manifest));

  if (adminReferenceFile && adminReferenceMappingConfig) {
    formData.append('referenceFile', adminReferenceFile);
    formData.append('adminReferenceMapping', JSON.stringify(adminReferenceMappingConfig));
  }

  appendMetadataFiles(formData, chunk.files, chunk.manifest);

  try {
    const response = await fetchFn('/api/imports/preview', { method: 'POST', body: formData });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      return { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: previewErrorMessage('UNEXPECTED_INTERNAL_ERROR') };
    }

    if (!response.ok) {
      const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : 'UNEXPECTED_INTERNAL_ERROR';
      return { success: false, code, error: previewErrorMessage(code) };
    }

    const validated = validateBrowserImportPreviewResponse(body);
    if (!validated) {
      return { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: previewErrorMessage('UNEXPECTED_INTERNAL_ERROR') };
    }
    return { success: true, batch: validated.batch };
  } catch {
    return { success: false, code: 'UNEXPECTED_INTERNAL_ERROR', error: previewErrorMessage('UNEXPECTED_INTERNAL_ERROR') };
  }
}

export async function runAnnualIntakePreview(
  params: AnnualIntakePreviewParams,
): Promise<AnnualIntakePreviewResult> {
  const {
    selectedFiles,
    selectedRootName,
    adminReferenceFile,
    adminReferenceMappingConfig,
    fetchFn = fetch,
    onProgress,
  } = params;

  const chunks = partitionAnnualIntakeFiles(selectedFiles, selectedRootName);
  if (chunks.length === 0) {
    return { success: false, code: 'NO_VALID_FILES', error: 'The selected folder contains no valid project packages.', failedChunkIndex: 0 };
  }

  const previewChunks: AnnualIntakePreviewChunk[] = [];
  for (const chunk of chunks) {
    let contentFingerprint: string;
    try {
      contentFingerprint = await fingerprintAnnualIntakeChunk(chunk.files, chunk.manifest);
    } catch {
      return {
        success: false,
        code: 'CONTENT_FINGERPRINT_UNAVAILABLE',
        error: previewErrorMessage('CONTENT_FINGERPRINT_UNAVAILABLE'),
        failedChunkIndex: chunk.index,
      };
    }

    const result = await requestPreviewChunk({
      chunk,
      adminReferenceFile,
      adminReferenceMappingConfig,
      fetchFn,
    });
    if (!result.success) return { ...result, failedChunkIndex: chunk.index };

    if (result.batch.packageCount > 25) {
      return {
        success: false,
        code: 'PACKAGE_LIMIT_EXCEEDED',
        error: previewErrorMessage('PACKAGE_LIMIT_EXCEEDED'),
        failedChunkIndex: chunk.index,
      };
    }

    previewChunks.push({ ...chunk, contentFingerprint, preview: result.batch });
    onProgress?.({
      completedChunks: previewChunks.length,
      totalChunks: chunks.length,
      packageCount: previewChunks.reduce((total, item) => total + item.preview.packageCount, 0),
    });
  }

  try {
    const cohortId = await createAnnualIntakeCohortId(
      selectedRootName,
      previewChunks.map((chunk) => chunk.contentFingerprint),
    );
    return {
      success: true,
      plan: {
        cohortId,
        selectedRootName,
        chunks: previewChunks,
        mergedPreview: await mergeAnnualIntakePreviews(selectedRootName, cohortId, previewChunks),
      },
    };
  } catch {
    return {
      success: false,
      code: 'CONTENT_FINGERPRINT_UNAVAILABLE',
      error: previewErrorMessage('CONTENT_FINGERPRINT_UNAVAILABLE'),
      failedChunkIndex: previewChunks.length,
    };
  }
}

export interface RunAnnualIntakeImportParams {
  plan: AnnualIntakePreviewPlan;
  selectedPackagePaths: string[];
  acknowledgedWarningPackagePaths: string[];
  existingProgress?: AnnualIntakeProgress | null;
  progressStore?: AnnualIntakeProgressStore;
  adminReferenceFile?: File | null;
  adminReferenceMappingConfig?: AdminReferenceMappingConfig | null;
  fetchFn?: typeof fetch;
  lockRunner?: AnnualIntakeLockRunner;
  onProgress?: (progress: AnnualIntakeProgress) => void;
}

export interface AnnualIntakeImportResult {
  success: boolean;
  progress: AnnualIntakeProgress;
  error: string | null;
  failedChunkIndex: number | null;
  code?: 'COHORT_IN_FLIGHT' | 'COHORT_LOCK_UNAVAILABLE' | 'PROGRESS_INVALID' | 'PROGRESS_READ_FAILED' | 'PROGRESS_WRITE_FAILED' | 'CONTENT_CHANGED' | 'CONTENT_FINGERPRINT_UNAVAILABLE';
}

class AnnualIntakeProgressStorageError extends Error {
  constructor(readonly operation: 'read' | 'write') {
    super(`Annual intake progress ${operation} failed.`);
  }
}

function cloneProgress(progress: AnnualIntakeProgress): AnnualIntakeProgress {
  return {
    ...progress,
    selectedPackagePaths: [...progress.selectedPackagePaths],
    acknowledgedWarningPackagePaths: [...progress.acknowledgedWarningPackagePaths],
    chunks: progress.chunks.map((chunk) => ({ ...chunk, packagePaths: [...chunk.packagePaths] })),
  };
}

function updateChunk(
  progress: AnnualIntakeProgress,
  chunkIndex: number,
  update: Partial<AnnualIntakeChunkProgress>,
): AnnualIntakeProgress {
  const next = cloneProgress(progress);
  next.chunks[chunkIndex] = { ...next.chunks[chunkIndex], ...update };
  return next;
}

function errorText(result: { error?: string } | null, fallback: string): string {
  return result?.error || fallback;
}

function selectedPathsForChunk(chunk: AnnualIntakePreviewChunk, selectedPackagePaths: string[]): string[] {
  const selected = new Set(selectedPackagePaths);
  return chunk.preview.packages
    .map((pkg) => pkg.packagePath)
    .filter((packagePath) => selected.has(packagePath))
    .sort(compareDeterministically);
}

function acknowledgedPathsForChunk(chunk: AnnualIntakePreviewChunk, acknowledgedWarningPackagePaths: string[]): string[] {
  const acknowledged = new Set(acknowledgedWarningPackagePaths);
  return chunk.preview.packages
    .map((pkg) => pkg.packagePath)
    .filter((packagePath) => acknowledged.has(packagePath))
    .sort(compareDeterministically);
}

async function verifyAnnualIntakePlanIdentity(
  plan: AnnualIntakePreviewPlan,
): Promise<
  | { success: true }
  | { success: false; code: 'CONTENT_CHANGED' | 'CONTENT_FINGERPRINT_UNAVAILABLE'; error: string }
> {
  const fingerprints: string[] = [];
  for (const chunk of plan.chunks) {
    let fingerprint: string;
    try {
      fingerprint = await fingerprintAnnualIntakeChunk(chunk.files, chunk.manifest);
    } catch {
      return {
        success: false,
        code: 'CONTENT_FINGERPRINT_UNAVAILABLE',
        error: 'The selected files could not be verified securely. Please re-select the folder and try again.',
      };
    }
    if (fingerprint !== chunk.contentFingerprint) {
      return {
        success: false,
        code: 'CONTENT_CHANGED',
        error: 'The selected files changed after preview. Please preview the folder again before importing.',
      };
    }
    fingerprints.push(fingerprint);
  }

  try {
    const cohortId = await createAnnualIntakeCohortId(plan.selectedRootName, fingerprints);
    if (cohortId !== plan.cohortId) {
      return {
        success: false,
        code: 'CONTENT_CHANGED',
        error: 'The annual intake identity no longer matches the preview. Please preview the folder again before importing.',
      };
    }
  } catch {
    return {
      success: false,
      code: 'CONTENT_FINGERPRINT_UNAVAILABLE',
      error: 'The selected files could not be verified securely. Please re-select the folder and try again.',
    };
  }

  return { success: true };
}

async function stageMetadataChunk(params: {
  chunk: AnnualIntakePreviewChunk;
  intent: BrowserImportCommitIntent;
  cohortId: string;
  adminReferenceFile?: File | null;
  adminReferenceMappingConfig?: AdminReferenceMappingConfig | null;
  fetchFn: typeof fetch;
}): Promise<Awaited<ReturnType<typeof runBrowserImportMetadataStaging>>> {
  return runBrowserImportMetadataStaging({
    lock: { current: false },
    isStaging: false,
    preparedIntent: params.intent,
    manifestCache: params.chunk.manifest,
    selectedFiles: params.chunk.files,
    adminReferenceFile: params.adminReferenceFile,
    adminReferenceMappingConfig: params.adminReferenceMappingConfig,
    cohortId: params.cohortId,
    setIsStaging: () => undefined,
    setStagingError: () => undefined,
    setStagedResult: () => undefined,
    fetchFn: params.fetchFn,
  });
}

async function stageMediaChunk(params: {
  chunk: AnnualIntakePreviewChunk;
  intent: BrowserImportCommitIntent;
  batchId: string;
  adminReferenceFile?: File | null;
  adminReferenceMappingConfig?: AdminReferenceMappingConfig | null;
  fetchFn: typeof fetch;
}): Promise<Awaited<ReturnType<typeof runBrowserImportMediaStaging>>> {
  return runBrowserImportMediaStaging({
    lock: { current: false },
    isCompletingMedia: false,
    batchId: params.batchId,
    preparedIntent: params.intent,
    manifestCache: params.chunk.manifest,
    selectedPackagePaths: params.intent.selectedPackagePaths,
    selectedFiles: params.chunk.files,
    adminReferenceFile: params.adminReferenceFile,
    adminReferenceMappingConfig: params.adminReferenceMappingConfig,
    setIsCompletingMedia: () => undefined,
    setMediaCompleteError: () => undefined,
    setMediaCompleteResult: () => undefined,
    fetchFn: params.fetchFn,
  });
}

async function executeAnnualIntakeImport(
  params: Omit<RunAnnualIntakeImportParams, 'lockRunner'>,
  progress: AnnualIntakeProgress,
): Promise<AnnualIntakeImportResult> {
  const {
    plan,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths,
    progressStore,
    adminReferenceFile,
    adminReferenceMappingConfig,
    fetchFn = fetch,
    onProgress,
  } = params;

  const publish = (next: AnnualIntakeProgress) => {
    try {
      progressStore?.write(next);
    } catch {
      throw new AnnualIntakeProgressStorageError('write');
    }
    progress = next;
    onProgress?.(progress);
  };

  if (selectedPackagePaths.length === 0) {
    const next = { ...progress, lastError: 'At least one project must be selected.', failedChunkIndex: null };
    publish(next);
    return { success: false, progress: next, error: next.lastError, failedChunkIndex: null };
  }

  for (const chunk of plan.chunks) {
    const current = progress.chunks[chunk.index];
    if (current.status === 'completed' || current.status === 'skipped') continue;

    const selectedForChunk = selectedPathsForChunk(chunk, selectedPackagePaths);
    const acknowledgedForChunk = acknowledgedPathsForChunk(chunk, acknowledgedWarningPackagePaths);

    if (selectedForChunk.length === 0) {
      publish(updateChunk(progress, chunk.index, {
        status: 'skipped',
        error: null,
        failurePhase: null,
      }));
      continue;
    }

    const prepared = prepareBrowserImportCommitIntentClient({
      manifest: chunk.manifest,
      preview: chunk.preview,
      selectedPackagePaths: selectedForChunk,
      acknowledgedWarningPackagePaths: acknowledgedForChunk,
      expectedPreviewFingerprint: chunk.preview.previewFingerprint,
    });

    if (!prepared.success) {
      const failed = updateChunk(progress, chunk.index, {
        status: 'failed',
        error: prepared.message,
        failurePhase: 'metadata',
      });
      publish({ ...failed, lastError: prepared.message, failedChunkIndex: chunk.index });
      return { success: false, progress: failed, error: prepared.message, failedChunkIndex: chunk.index };
    }

    let batchId = current.batchId;
    let mediaAssetCount = current.mediaAssetCount;
    const resumeMediaOnly = current.status === 'failed' && current.failurePhase === 'media' && Boolean(batchId);

    if (!resumeMediaOnly) {
      const metadataResult = await stageMetadataChunk({
        chunk,
        intent: prepared.intent,
        cohortId: plan.cohortId,
        adminReferenceFile,
        adminReferenceMappingConfig,
        fetchFn,
      });

      if (!metadataResult || !metadataResult.success) {
        const message = errorText(metadataResult && !metadataResult.success ? metadataResult : null, 'The metadata chunk could not be staged.');
        const failed = updateChunk(progress, chunk.index, {
          status: 'failed',
          error: message,
          failurePhase: 'metadata',
        });
        publish({ ...failed, lastError: message, failedChunkIndex: chunk.index });
        return { success: false, progress: failed, error: message, failedChunkIndex: chunk.index };
      }

      batchId = metadataResult.batchId;
      publish(updateChunk(progress, chunk.index, {
        status: 'metadata_staged',
        batchId,
        error: null,
        failurePhase: null,
      }));
    }

    if (!batchId) {
      const message = 'The metadata chunk did not return a recoverable batch identifier.';
      const failed = updateChunk(progress, chunk.index, {
        status: 'failed',
        error: message,
        failurePhase: 'metadata',
      });
      publish({ ...failed, lastError: message, failedChunkIndex: chunk.index });
      return { success: false, progress: failed, error: message, failedChunkIndex: chunk.index };
    }

    const mediaResult = await stageMediaChunk({
      chunk,
      intent: prepared.intent,
      batchId,
      adminReferenceFile,
      adminReferenceMappingConfig,
      fetchFn,
    });

    if (!mediaResult || !mediaResult.success) {
      const message = errorText(mediaResult && !mediaResult.success ? mediaResult : null, 'The media chunk could not be completed.');
      const failed = updateChunk(progress, chunk.index, {
        status: 'failed',
        batchId,
        error: message,
        failurePhase: 'media',
      });
      publish({ ...failed, lastError: message, failedChunkIndex: chunk.index });
      return { success: false, progress: failed, error: message, failedChunkIndex: chunk.index };
    }

    mediaAssetCount = mediaResult.mediaAssetCount;
    publish(updateChunk(progress, chunk.index, {
      status: 'completed',
      batchId: mediaResult.batchId,
      mediaAssetCount,
      error: null,
      failurePhase: null,
    }));
  }

  const complete = {
    ...progress,
    lastError: null,
    failedChunkIndex: null,
  };
  publish(complete);
  return { success: true, progress: complete, error: null, failedChunkIndex: null };
}

export async function runAnnualIntakeImport(
  params: RunAnnualIntakeImportParams,
): Promise<AnnualIntakeImportResult> {
  const {
    plan,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths,
    existingProgress,
    lockRunner = withAnnualIntakeInFlightLock,
  } = params;

  const fallbackProgress = canResumeAnnualIntake(
    existingProgress || null,
    plan,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths,
  )
    ? cloneProgress(existingProgress!)
    : createInitialAnnualIntakeProgress(plan, selectedPackagePaths, acknowledgedWarningPackagePaths);

  let progress = fallbackProgress;
  let locked: AnnualIntakeLockResult<AnnualIntakeImportResult>;
  try {
    locked = await lockRunner(plan.cohortId, async () => {
    let storedProgress: unknown = null;
    try {
      storedProgress = params.progressStore?.read(plan.cohortId) ?? null;
    } catch {
      return {
        success: false,
        progress,
        error: 'Annual intake progress could not be read safely. Check browser storage permissions and try again.',
        failedChunkIndex: null,
        code: 'PROGRESS_READ_FAILED' as const,
      };
    }

    if (storedProgress !== null) {
      if (!canResumeAnnualIntake(
        storedProgress,
        plan,
        selectedPackagePaths,
        acknowledgedWarningPackagePaths,
      )) {
        return {
          success: false,
          progress,
          error: 'Saved annual intake progress could not be verified. Please preview the folder again before importing.',
          failedChunkIndex: null,
          code: 'PROGRESS_INVALID' as const,
        };
      }
      progress = cloneProgress(storedProgress);
    } else if (canResumeAnnualIntake(
      existingProgress || null,
      plan,
      selectedPackagePaths,
      acknowledgedWarningPackagePaths,
    )) {
      progress = cloneProgress(existingProgress!);
    } else {
      progress = createInitialAnnualIntakeProgress(plan, selectedPackagePaths, acknowledgedWarningPackagePaths);
    }

    const identity = await verifyAnnualIntakePlanIdentity(plan);
    if (!identity.success) {
      return {
        success: false,
        progress,
        error: identity.error,
        failedChunkIndex: null,
        code: identity.code,
      };
    }

    try {
      params.progressStore?.write(progress);
    } catch {
      return {
        success: false,
        progress,
        error: 'Annual intake progress could not be saved safely. Check browser storage permissions and try again.',
        failedChunkIndex: null,
        code: 'PROGRESS_WRITE_FAILED' as const,
      };
    }

      return executeAnnualIntakeImport(params, progress);
    });
  } catch (error) {
    if (error instanceof AnnualIntakeProgressStorageError && error.operation === 'write') {
      return {
        success: false,
        progress,
        error: 'Annual intake progress could not be saved safely. Check browser storage permissions and try again.',
        failedChunkIndex: null,
        code: 'PROGRESS_WRITE_FAILED',
      };
    }
    throw error;
  }
  if (locked.acquired && locked.value) return locked.value;

  const unavailable = locked.reason === 'unavailable';
  return {
    success: false,
    progress,
    error: unavailable
      ? 'This browser cannot safely coordinate an annual intake across tabs. Please use a supported Chromium browser and try again.'
      : 'This annual intake is already being processed in another tab or action. Wait for it to finish, then retry.',
    failedChunkIndex: null,
    code: unavailable ? 'COHORT_LOCK_UNAVAILABLE' : 'COHORT_IN_FLIGHT',
  };
}

export { formatAnnualIntakeSourceFolder };
