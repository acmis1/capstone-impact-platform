import {
  BROWSER_IMPORT_LIMITS,
  buildBrowserSelectionDescriptor,
  type BrowserImportIssue,
  type BrowserImportPackagePreview,
  type BrowserImportPreviewBatch,
  type SelectedFileDescriptor,
  type SelectionManifest,
} from './browserImportPreviewContract';
import { isIgnoredSystemFile, normalizeRelativePath } from './browserSelection';

export const ANNUAL_INTAKE_COHORT_ID_REGEX = /^annual-[a-f0-9]{64}$/;
export const ANNUAL_INTAKE_PROGRESS_VERSION = 1 as const;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnnualIntakeChunkStatus = 'pending' | 'skipped' | 'metadata_staged' | 'completed' | 'failed';
export type AnnualIntakeFailurePhase = 'preview' | 'metadata' | 'media' | null;

export interface AnnualIntakeFileChunk {
  index: number;
  packagePaths: string[];
  files: File[];
  manifest: SelectionManifest;
  contentFingerprint?: string;
}

export interface AnnualIntakePreviewChunk extends AnnualIntakeFileChunk {
  contentFingerprint: string;
  preview: BrowserImportPreviewBatch;
}

export interface AnnualIntakePreviewPlan {
  cohortId: string;
  selectedRootName: string;
  chunks: AnnualIntakePreviewChunk[];
  mergedPreview: BrowserImportPreviewBatch;
}

export interface AnnualIntakeChunkProgress {
  index: number;
  packagePaths: string[];
  contentFingerprint: string;
  previewFingerprint: string;
  status: AnnualIntakeChunkStatus;
  batchId: string | null;
  mediaAssetCount: number;
  error: string | null;
  failurePhase: AnnualIntakeFailurePhase;
}

export interface AnnualIntakeProgress {
  version: typeof ANNUAL_INTAKE_PROGRESS_VERSION;
  cohortId: string;
  selectedRootName: string;
  packageCount: number;
  selectedPackagePaths: string[];
  acknowledgedWarningPackagePaths: string[];
  chunks: AnnualIntakeChunkProgress[];
  lastError: string | null;
  failedChunkIndex: number | null;
}

export interface AnnualIntakeProgressStore {
  read: (cohortId: string) => unknown | null;
  write: (progress: AnnualIntakeProgress) => void;
  clear?: (cohortId: string) => void;
}

export interface AnnualIntakeLockResult<T> {
  acquired: boolean;
  value?: T;
  reason?: 'busy' | 'unavailable';
}

export type AnnualIntakeLockRunner = <T>(
  cohortId: string,
  task: () => Promise<T>,
) => Promise<AnnualIntakeLockResult<T>>;

export function isAnnualIntakeCohortId(value: unknown): value is string {
  return typeof value === 'string' && ANNUAL_INTAKE_COHORT_ID_REGEX.test(value);
}

export function formatAnnualIntakeSourceFolder(selectedRootName: string, cohortId: string): string {
  return `${selectedRootName} [annual cohort ${cohortId}]`;
}

export function compareDeterministically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Text(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable.');
  return bytesToHex(await subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function fingerprintAnnualIntakeChunk(
  files: File[],
  manifest: SelectionManifest,
): Promise<string> {
  const filesByPath = new Map<string, File>();
  for (const file of files) {
    const normalizedPath = normalizeRelativePath(file.webkitRelativePath || file.name);
    if (!normalizedPath || isIgnoredSystemFile(normalizedPath)) continue;
    if (filesByPath.has(normalizedPath)) throw new Error('Duplicate selected file path.');
    filesByPath.set(normalizedPath, file);
  }

  const records: string[] = [];
  for (const descriptor of manifest.descriptors) {
    const normalizedPath = normalizeRelativePath(descriptor.originalPath);
    const file = normalizedPath ? filesByPath.get(normalizedPath) : undefined;
    if (!file || file.size !== descriptor.fileSizeBytes) {
      throw new Error('Selected file content could not be verified.');
    }
    if (typeof file.arrayBuffer !== 'function') {
      throw new Error('Selected file content could not be read securely.');
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== descriptor.fileSizeBytes) {
      throw new Error('Selected file content size changed.');
    }
    const digest = bytesToHex(await (globalThis.crypto?.subtle
      ? globalThis.crypto.subtle.digest('SHA-256', bytes)
      : Promise.reject(new Error('Web Crypto SHA-256 is unavailable.'))));
    records.push([
      normalizedPath || descriptor.originalPath,
      descriptor.fileSizeBytes,
      descriptor.browserMimeType,
      digest,
    ].join('\u0000'));
  }

  return sha256Text(records.sort(compareDeterministically).join('\u0001'));
}

export async function createAnnualIntakeCohortId(
  selectedRootName: string,
  chunkContentFingerprints: string[],
): Promise<string> {
  if (!chunkContentFingerprints.length || chunkContentFingerprints.some((fingerprint) => !SHA256_HEX_REGEX.test(fingerprint))) {
    throw new Error('Annual intake content identity is unavailable.');
  }
  const canonical = chunkContentFingerprints
    .map((fingerprint, index) => `${index}\u0000${fingerprint}`)
    .join('\u0001');
  return `annual-${await sha256Text(`${selectedRootName}\u0002${canonical}`)}`;
}

function packagePathForDescriptor(normalizedPath: string): string | null {
  const parts = normalizedPath.split('/');
  if (parts.length <= 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

function descriptorInfo(file: File): {
  descriptor: SelectedFileDescriptor;
  normalizedPath: string;
  packagePath: string | null;
  ignored: boolean;
} | null {
  const rawPath = file.webkitRelativePath || file.name;
  const normalizedPath = normalizeRelativePath(rawPath);
  if (!normalizedPath) return null;
  const ignored = isIgnoredSystemFile(normalizedPath);
  if (ignored) {
    return {
      descriptor: buildBrowserSelectionDescriptor(rawPath, file.size, file.type) || {
        uploadKey: '',
        originalPath: rawPath,
        fileSizeBytes: file.size,
        browserMimeType: file.type,
      },
      normalizedPath,
      packagePath: null,
      ignored: true,
    };
  }
  const descriptor = buildBrowserSelectionDescriptor(rawPath, file.size, file.type);
  if (!descriptor) return null;
  return {
    descriptor,
    normalizedPath,
    packagePath: packagePathForDescriptor(normalizedPath),
    ignored: false,
  };
}

function buildManifest(
  selectedRootName: string,
  entries: Array<{ file: File; info: NonNullable<ReturnType<typeof descriptorInfo>> }>,
): SelectionManifest {
  const descriptors = entries
    .filter(({ info }) => !info.ignored)
    .sort((left, right) => compareDeterministically(left.info.normalizedPath, right.info.normalizedPath))
    .map(({ info }) => info.descriptor);
  const ignoredSystemFilesCount = entries.filter(({ info }) => info.ignored).length;

  return {
    selectedRootName,
    fileCount: descriptors.length,
    declaredTotalBytes: descriptors.reduce((total, descriptor) => total + descriptor.fileSizeBytes, 0),
    ignoredSystemFilesCount,
    descriptors,
  };
}

function isMetadataPath(path: string): boolean {
  const fileName = path.split('/').pop()?.toLowerCase();
  return fileName === 'project-details.xlsx' || fileName === 'project.json';
}

function fitsExistingRequestLimits(
  selectedRootName: string,
  entries: Array<{ file: File; info: NonNullable<ReturnType<typeof descriptorInfo>> }>,
  packageCount: number,
): boolean {
  if (packageCount > BROWSER_IMPORT_LIMITS.MAX_PACKAGES) return false;
  const manifest = buildManifest(selectedRootName, entries);
  const metadataDescriptors = manifest.descriptors.filter((descriptor) => isMetadataPath(descriptor.originalPath));
  return manifest.descriptors.length <= BROWSER_IMPORT_LIMITS.MAX_DESCRIPTORS
    && metadataDescriptors.length <= BROWSER_IMPORT_LIMITS.MAX_METADATA_FILES
    && metadataDescriptors.reduce((total, descriptor) => total + descriptor.fileSizeBytes, 0) <= BROWSER_IMPORT_LIMITS.MAX_TOTAL_METADATA_BYTES
    && JSON.stringify(manifest).length <= BROWSER_IMPORT_LIMITS.MAX_MANIFEST_SIZE_BYTES;
}

/** Partitions a selected folder by whole package while preserving the existing request ceilings. */
export function partitionAnnualIntakeFiles(
  files: File[],
  selectedRootName: string,
): AnnualIntakeFileChunk[] {
  const entries = files
    .map((file) => ({ file, info: descriptorInfo(file) }))
    .filter((entry): entry is { file: File; info: NonNullable<ReturnType<typeof descriptorInfo>> } => entry.info !== null);

  const packagePaths = Array.from(new Set(
    entries
      .filter(({ info }) => !info.ignored && info.packagePath !== null)
      .map(({ info }) => info.packagePath!),
  )).sort(compareDeterministically);

  const looseEntries = entries.filter(({ info }) => info.ignored || info.packagePath === null);
  const entriesByPackage = new Map<string, Array<{ file: File; info: NonNullable<ReturnType<typeof descriptorInfo>> }>>();
  for (const entry of entries) {
    if (!entry.info.packagePath) continue;
    const packageEntries = entriesByPackage.get(entry.info.packagePath) || [];
    packageEntries.push(entry);
    entriesByPackage.set(entry.info.packagePath, packageEntries);
  }

  const chunks: AnnualIntakeFileChunk[] = [];
  let currentEntries = looseEntries;
  let currentPackagePaths: string[] = [];

  const appendChunk = () => {
    if (currentEntries.length === 0 && currentPackagePaths.length === 0) return;
    const chunkEntries = currentEntries
      .slice()
      .sort((left, right) => compareDeterministically(left.info.normalizedPath, right.info.normalizedPath));
    chunks.push({
      index: chunks.length,
      packagePaths: [...currentPackagePaths],
      files: chunkEntries.map(({ file }) => file),
      manifest: buildManifest(selectedRootName, chunkEntries),
    });
  };

  for (const packagePath of packagePaths) {
    const packageEntries = entriesByPackage.get(packagePath) || [];
    const candidateEntries = [...currentEntries, ...packageEntries];
    const candidatePackagePaths = [...currentPackagePaths, packagePath];
    const candidateFits = fitsExistingRequestLimits(selectedRootName, candidateEntries, candidatePackagePaths.length);

    if (currentPackagePaths.length > 0 && !candidateFits) {
      appendChunk();
      currentEntries = [];
      currentPackagePaths = [];
    } else if (currentPackagePaths.length === 0 && currentEntries.length > 0 && !candidateFits) {
      appendChunk();
      currentEntries = [];
    }

    currentEntries.push(...packageEntries);
    currentPackagePaths.push(packagePath);
  }

  appendChunk();
  return chunks;
}

function mergeIssues(chunks: AnnualIntakePreviewChunk[]): BrowserImportIssue[] {
  return chunks.flatMap((chunk) => chunk.preview.batchIssues);
}

export async function mergeAnnualIntakePreviews(
  selectedRootName: string,
  cohortId: string,
  chunks: AnnualIntakePreviewChunk[],
): Promise<BrowserImportPreviewBatch> {
  const packages = chunks
    .flatMap((chunk) => chunk.preview.packages)
    .sort((left, right) => compareDeterministically(left.packagePath, right.packagePath));
  const batchIssues = mergeIssues(chunks);
  const previewFingerprint = await sha256Text([
    cohortId,
    ...chunks.map((chunk) => `${chunk.index}:${chunk.preview.previewFingerprint}`),
  ].join('\u0001'));

  const count = (status: BrowserImportPackagePreview['status']) => packages.filter((pkg) => pkg.status === status).length;
  const totalWarnings = packages.reduce((total, pkg) => total + pkg.warnings.length, 0)
    + batchIssues.filter((issue) => issue.severity === 'warning').length;
  const totalErrors = packages.reduce((total, pkg) => total + pkg.errors.length, 0)
    + batchIssues.filter((issue) => issue.severity === 'error').length;

  return {
    previewFingerprint,
    mode: 'batch',
    selectedRootName,
    packageCount: packages.length,
    selectedFileCount: chunks.reduce((total, chunk) => total + chunk.preview.selectedFileCount, 0),
    declaredTotalBytes: chunks.reduce((total, chunk) => total + chunk.preview.declaredTotalBytes, 0),
    validPackageCount: count('valid'),
    warningPackageCount: count('warning'),
    invalidPackageCount: count('invalid'),
    totalWarnings,
    totalErrors,
    mediaValidationMode: 'descriptor_only',
    batchIssues,
    packages,
    ...(chunks[0]?.preview.adminReference ? { adminReference: chunks[0].preview.adminReference } : {}),
  };
}

export function createInitialAnnualIntakeProgress(
  plan: Pick<AnnualIntakePreviewPlan, 'cohortId' | 'selectedRootName' | 'chunks'>,
  selectedPackagePaths: string[],
  acknowledgedWarningPackagePaths: string[],
): AnnualIntakeProgress {
  return {
    version: ANNUAL_INTAKE_PROGRESS_VERSION,
    cohortId: plan.cohortId,
    selectedRootName: plan.selectedRootName,
    packageCount: plan.chunks.reduce((total, chunk) => total + chunk.preview.packageCount, 0),
    selectedPackagePaths: [...selectedPackagePaths].sort(compareDeterministically),
    acknowledgedWarningPackagePaths: [...acknowledgedWarningPackagePaths].sort(compareDeterministically),
    chunks: plan.chunks.map((chunk) => ({
      index: chunk.index,
      packagePaths: [...chunk.packagePaths],
      contentFingerprint: chunk.contentFingerprint,
      previewFingerprint: chunk.preview.previewFingerprint,
      status: 'pending',
      batchId: null,
      mediaAssetCount: 0,
      error: null,
      failurePhase: null,
    })),
    lastError: null,
    failedChunkIndex: null,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isProgressChunk(value: unknown): value is AnnualIntakeChunkProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const chunk = value as Record<string, unknown>;
  const allowedKeys = ['index', 'packagePaths', 'contentFingerprint', 'previewFingerprint', 'status', 'batchId', 'mediaAssetCount', 'error', 'failurePhase'];
  if (Object.keys(chunk).length !== allowedKeys.length || !Object.keys(chunk).every((key) => allowedKeys.includes(key))) return false;
  const validFields = Number.isInteger(chunk.index)
    && isStringArray(chunk.packagePaths)
    && typeof chunk.contentFingerprint === 'string'
    && SHA256_HEX_REGEX.test(chunk.contentFingerprint)
    && typeof chunk.previewFingerprint === 'string'
    && SHA256_HEX_REGEX.test(chunk.previewFingerprint)
    && (chunk.status === 'pending' || chunk.status === 'skipped' || chunk.status === 'metadata_staged' || chunk.status === 'completed' || chunk.status === 'failed')
    && (chunk.batchId === null || (typeof chunk.batchId === 'string' && UUID_REGEX.test(chunk.batchId)))
    && Number.isInteger(chunk.mediaAssetCount)
    && (chunk.mediaAssetCount as number) >= 0
    && (chunk.error === null || typeof chunk.error === 'string')
    && (chunk.failurePhase === null || chunk.failurePhase === 'preview' || chunk.failurePhase === 'metadata' || chunk.failurePhase === 'media');
  if (!validFields) return false;

  if (chunk.status === 'pending') {
    return chunk.batchId === null && chunk.mediaAssetCount === 0 && chunk.error === null && chunk.failurePhase === null;
  }
  if (chunk.status === 'skipped') {
    return chunk.batchId === null && chunk.mediaAssetCount === 0 && chunk.error === null && chunk.failurePhase === null;
  }
  if (chunk.status === 'metadata_staged') {
    return chunk.batchId !== null && chunk.error === null && chunk.failurePhase === null;
  }
  if (chunk.status === 'completed') {
    return chunk.batchId !== null && chunk.error === null && chunk.failurePhase === null;
  }
  return typeof chunk.error === 'string' && chunk.error.trim() !== '' && chunk.failurePhase !== null;
}

export function isStoredAnnualIntakeProgress(value: unknown): value is AnnualIntakeProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  const allowedKeys = ['version', 'cohortId', 'selectedRootName', 'packageCount', 'selectedPackagePaths', 'acknowledgedWarningPackagePaths', 'chunks', 'lastError', 'failedChunkIndex'];
  if (Object.keys(progress).length !== allowedKeys.length || !Object.keys(progress).every((key) => allowedKeys.includes(key))) return false;
  if (!(progress.version === ANNUAL_INTAKE_PROGRESS_VERSION
    && isAnnualIntakeCohortId(progress.cohortId)
    && typeof progress.selectedRootName === 'string'
    && progress.selectedRootName.length > 0
    && Number.isInteger(progress.packageCount)
    && (progress.packageCount as number) >= 0
    && isStringArray(progress.selectedPackagePaths)
    && isStringArray(progress.acknowledgedWarningPackagePaths)
    && Array.isArray(progress.chunks)
    && progress.chunks.every(isProgressChunk)
    && (progress.lastError === null || (typeof progress.lastError === 'string' && progress.lastError.trim() !== ''))
    && (progress.failedChunkIndex === null || Number.isInteger(progress.failedChunkIndex))
  )) return false;

  const selected = progress.selectedPackagePaths as string[];
  const acknowledged = progress.acknowledgedWarningPackagePaths as string[];
  const chunks = progress.chunks as AnnualIntakeChunkProgress[];
  if (new Set(selected).size !== selected.length || new Set(acknowledged).size !== acknowledged.length) return false;
  if (progress.failedChunkIndex !== null) {
    const failedChunk = chunks[progress.failedChunkIndex as number];
    if (!failedChunk || failedChunk.status !== 'failed') return false;
  }
  return true;
}

export function canResumeAnnualIntake(
  progress: unknown,
  plan: Pick<AnnualIntakePreviewPlan, 'cohortId' | 'selectedRootName' | 'chunks'>,
  selectedPackagePaths: string[],
  acknowledgedWarningPackagePaths: string[],
): progress is AnnualIntakeProgress {
  if (!isStoredAnnualIntakeProgress(progress)) return false;
  if (progress.cohortId !== plan.cohortId || !isAnnualIntakeCohortId(plan.cohortId) || progress.selectedRootName !== plan.selectedRootName) return false;
  if (progress.packageCount !== plan.chunks.reduce((total, chunk) => total + chunk.preview.packageCount, 0)) return false;

  const expectedSelected = [...selectedPackagePaths].sort(compareDeterministically);
  const expectedAcknowledged = [...acknowledgedWarningPackagePaths].sort(compareDeterministically);
  if (new Set(expectedSelected).size !== expectedSelected.length || new Set(expectedAcknowledged).size !== expectedAcknowledged.length) return false;
  const planPackagePaths = new Set(plan.chunks.flatMap((chunk) => chunk.preview.packages.map((pkg) => pkg.packagePath)));
  if (expectedSelected.some((path) => !planPackagePaths.has(path)) || expectedAcknowledged.some((path) => !planPackagePaths.has(path))) return false;

  return JSON.stringify(progress.selectedPackagePaths) === JSON.stringify(expectedSelected)
    && JSON.stringify(progress.acknowledgedWarningPackagePaths) === JSON.stringify(expectedAcknowledged)
    && progress.chunks.length === plan.chunks.length
    && progress.chunks.every((chunk, index) => {
      const planChunk = plan.chunks[index];
      return chunk.index === index
        && JSON.stringify(chunk.packagePaths) === JSON.stringify(planChunk.packagePaths)
        && chunk.contentFingerprint === planChunk.contentFingerprint
        && chunk.previewFingerprint === planChunk.preview.previewFingerprint;
    });
}

export function createBrowserAnnualIntakeProgressStore(
  storageKeyPrefix = 'admin-cms.annual-intake.v1',
): AnnualIntakeProgressStore {
  return {
    read: (cohortId) => {
      let storage: Storage | undefined;
      try {
        storage = globalThis.localStorage;
      } catch {
        throw new Error('Annual intake progress storage is unavailable.');
      }
      if (!storage) throw new Error('Annual intake progress storage is unavailable.');

      let raw: string | null;
      try {
        raw = storage.getItem(`${storageKeyPrefix}.${cohortId}`);
      } catch {
        throw new Error('Annual intake progress storage could not be read.');
      }
      if (raw === null) return null;

      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed === null ? {} : parsed;
      } catch {
        return {};
      }
    },
    write: (progress) => {
      if (!isStoredAnnualIntakeProgress(progress)) throw new Error('Annual intake progress is invalid.');
      let storage: Storage | undefined;
      try {
        storage = globalThis.localStorage;
      } catch {
        throw new Error('Annual intake progress storage is unavailable.');
      }
      if (!storage) throw new Error('Annual intake progress storage is unavailable.');
      try {
        storage.setItem(`${storageKeyPrefix}.${progress.cohortId}`, JSON.stringify(progress));
      } catch {
        throw new Error('Annual intake progress storage could not be written.');
      }
    },
    clear: (cohortId) => {
      try {
        globalThis.localStorage?.removeItem(`${storageKeyPrefix}.${cohortId}`);
      } catch {
        // Best-effort cleanup only.
      }
    },
  };
}

/**
 * Web Locks are origin-wide and therefore coordinate repeated actions and separate tabs.
 * If the browser does not provide them, fail closed instead of pretending a local lock is
 * shared across tabs.
 */
export async function withAnnualIntakeInFlightLock<T>(
  cohortId: string,
  task: () => Promise<T>,
): Promise<AnnualIntakeLockResult<T>> {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!lockManager || typeof lockManager.request !== 'function') return { acquired: false, reason: 'unavailable' };

  let value: T | undefined;
  let acquired = false;
  let taskFailed = false;
  let taskError: unknown;
  try {
    await lockManager.request(
      `admin-cms.annual-intake.${cohortId}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        acquired = true;
        try {
          value = await task();
        } catch (error) {
          taskFailed = true;
          taskError = error;
        }
      },
    );
  } catch {
    if (taskFailed) throw taskError;
    return { acquired: false, reason: 'unavailable' };
  }
  if (taskFailed) throw taskError;
  return acquired ? { acquired: true, value } : { acquired: false, reason: 'busy' };
}
