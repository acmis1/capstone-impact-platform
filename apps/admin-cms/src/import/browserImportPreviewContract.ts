import { z } from 'zod';

/**
 * Shared Server & Client Limits
 */
export const BROWSER_IMPORT_LIMITS = {
  MAX_PACKAGES: 25,
  MAX_DESCRIPTORS: 500,
  MAX_METADATA_FILES: 25,
  MAX_XLSX_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
  MAX_JSON_SIZE_BYTES: 1 * 1024 * 1024, // 1 MB
  MAX_IMAGE_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB
  MAX_PDF_SIZE_BYTES: 25 * 1024 * 1024, // 25 MB
  MAX_TOTAL_METADATA_BYTES: 25 * 1024 * 1024, // 25 MB
  MAX_MANIFEST_SIZE_BYTES: 1 * 1024 * 1024, // 1 MB
  MAX_MULTIPART_REQUEST_BYTES: 27 * 1024 * 1024, // ~27 MB total request size ceiling

  // String bounds
  MAX_STRING_PATH: 500,
  MAX_STRING_NAME: 100,
  MAX_STRING_MIME: 100,
  MAX_STRING_KEY: 200,
} as const;

/**
 * Known Issue Code Types
 */
export type BrowserImportIssueSeverity = 'error' | 'warning';

export interface BrowserImportIssue {
  code: string;
  message: string;
  severity: BrowserImportIssueSeverity;
  packagePath?: string;
  fileName?: string;
  fieldName?: string;
  columnName?: string;
  rowNumber?: number;
}

/**
 * Selected File Descriptor Interface
 */
export interface SelectedFileDescriptor {
  uploadKey: string;
  originalPath: string;
  normalizedPath: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  packagePath: string;
}

/**
 * Selection Manifest Interface
 */
export interface SelectionManifest {
  selectedRootName: string;
  fileCount: number;
  declaredTotalBytes: number;
  ignoredSystemFilesCount: number;
  descriptors: SelectedFileDescriptor[];
}

/**
 * Package Preview Metadata Summary
 */
export interface BrowserImportPreviewMetadata {
  title: string;
  year: string;
  program: string;
  discipline: string;
  groupName: string;
  teamMemberCount: number;
  layoutTemplate: string;
  featuredMedia: string;
}

/**
 * Individual Package Preview Object
 */
export interface BrowserImportPackagePreview {
  packagePath: string;
  folderName: string;
  proposedPublicId: string;
  metadataSource: 'xlsx' | 'json' | null;
  status: 'valid' | 'warning' | 'invalid';
  previewMetadata: BrowserImportPreviewMetadata | null;
  filePresence: {
    xlsxPresent: boolean;
    jsonPresent: boolean;
    posterImagePresent: boolean;
    posterPdfPresent: boolean;
    snapshotPresent: boolean;
  };
  errors: BrowserImportIssue[];
  warnings: BrowserImportIssue[];
}

/**
 * Full Server Preview Response Batch Object
 */
export interface BrowserImportPreviewBatch {
  mode: 'single' | 'batch';
  selectedRootName: string;
  packageCount: number;
  selectedFileCount: number;
  declaredTotalBytes: number;
  validPackageCount: number;
  warningPackageCount: number;
  invalidPackageCount: number;
  totalWarnings: number;
  totalErrors: number;
  mediaValidationMode: 'descriptor_only';
  batchIssues: BrowserImportIssue[];
  packages: BrowserImportPackagePreview[];
}

export interface BrowserImportPreviewResponse {
  success: true;
  batch: BrowserImportPreviewBatch;
}

/**
 * Strict Zod Schemas for Runtime Request Validation
 */
export const selectedFileDescriptorSchema = z.object({
  uploadKey: z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_KEY),
  originalPath: z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_PATH),
  normalizedPath: z.string().max(BROWSER_IMPORT_LIMITS.MAX_STRING_PATH).optional().default(''),
  fileName: z.string().max(BROWSER_IMPORT_LIMITS.MAX_STRING_NAME).optional().default(''),
  fileSizeBytes: z.number().int().nonnegative().finite(),
  mimeType: z.string().max(BROWSER_IMPORT_LIMITS.MAX_STRING_MIME).optional().default(''),
  packagePath: z.string().max(BROWSER_IMPORT_LIMITS.MAX_STRING_PATH).optional().default(''),
});

export const selectionManifestSchema = z.object({
  selectedRootName: z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_NAME),
  fileCount: z.number().int().nonnegative().finite(),
  declaredTotalBytes: z.number().int().nonnegative().finite(),
  ignoredSystemFilesCount: z.number().int().nonnegative().finite(),
  descriptors: z
    .array(selectedFileDescriptorSchema)
    .max(BROWSER_IMPORT_LIMITS.MAX_DESCRIPTORS),
});

/**
 * Pure Client-Safe Runtime Response Guard
 */
export function validateBrowserImportPreviewResponse(raw: unknown): BrowserImportPreviewResponse | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  if (obj.success !== true || !obj.batch || typeof obj.batch !== 'object') return null;

  const batch = obj.batch as Record<string, unknown>;

  if (batch.mode !== 'single' && batch.mode !== 'batch') return null;
  if (typeof batch.selectedRootName !== 'string') return null;
  if (typeof batch.packageCount !== 'number' || !Number.isFinite(batch.packageCount) || batch.packageCount < 0) return null;
  if (typeof batch.selectedFileCount !== 'number' || !Number.isFinite(batch.selectedFileCount) || batch.selectedFileCount < 0) return null;
  if (typeof batch.declaredTotalBytes !== 'number' || !Number.isFinite(batch.declaredTotalBytes) || batch.declaredTotalBytes < 0) return null;
  if (typeof batch.validPackageCount !== 'number' || !Number.isFinite(batch.validPackageCount) || batch.validPackageCount < 0) return null;
  if (typeof batch.warningPackageCount !== 'number' || !Number.isFinite(batch.warningPackageCount) || batch.warningPackageCount < 0) return null;
  if (typeof batch.invalidPackageCount !== 'number' || !Number.isFinite(batch.invalidPackageCount) || batch.invalidPackageCount < 0) return null;
  if (typeof batch.totalWarnings !== 'number' || !Number.isFinite(batch.totalWarnings) || batch.totalWarnings < 0) return null;
  if (typeof batch.totalErrors !== 'number' || !Number.isFinite(batch.totalErrors) || batch.totalErrors < 0) return null;
  if (batch.mediaValidationMode !== 'descriptor_only') return null;
  if (!Array.isArray(batch.packages)) return null;

  const packages: BrowserImportPackagePreview[] = [];

  for (const item of batch.packages) {
    if (!item || typeof item !== 'object') return null;
    const pkg = item as Record<string, unknown>;

    if (typeof pkg.packagePath !== 'string' || typeof pkg.folderName !== 'string' || typeof pkg.proposedPublicId !== 'string') return null;
    if (pkg.status !== 'valid' && pkg.status !== 'warning' && pkg.status !== 'invalid') return null;
    if (pkg.metadataSource !== 'xlsx' && pkg.metadataSource !== 'json' && pkg.metadataSource !== null) return null;

    if (!pkg.filePresence || typeof pkg.filePresence !== 'object') return null;
    const fp = pkg.filePresence as Record<string, unknown>;
    if (
      typeof fp.xlsxPresent !== 'boolean' ||
      typeof fp.jsonPresent !== 'boolean' ||
      typeof fp.posterImagePresent !== 'boolean' ||
      typeof fp.posterPdfPresent !== 'boolean' ||
      typeof fp.snapshotPresent !== 'boolean'
    ) {
      return null;
    }

    if (!Array.isArray(pkg.errors) || !Array.isArray(pkg.warnings)) return null;

    let previewMetadata: BrowserImportPreviewMetadata | null = null;
    if (pkg.previewMetadata && typeof pkg.previewMetadata === 'object') {
      const pm = pkg.previewMetadata as Record<string, unknown>;
      previewMetadata = {
        title: String(pm.title || ''),
        year: String(pm.year || ''),
        program: String(pm.program || ''),
        discipline: String(pm.discipline || ''),
        groupName: String(pm.groupName || ''),
        teamMemberCount: typeof pm.teamMemberCount === 'number' && Number.isFinite(pm.teamMemberCount) ? pm.teamMemberCount : 0,
        layoutTemplate: String(pm.layoutTemplate || 'poster_showcase'),
        featuredMedia: String(pm.featuredMedia || 'poster'),
      };
    }

    packages.push({
      packagePath: pkg.packagePath,
      folderName: pkg.folderName,
      proposedPublicId: pkg.proposedPublicId,
      metadataSource: pkg.metadataSource,
      status: pkg.status,
      previewMetadata,
      filePresence: {
        xlsxPresent: fp.xlsxPresent,
        jsonPresent: fp.jsonPresent,
        posterImagePresent: fp.posterImagePresent,
        posterPdfPresent: fp.posterPdfPresent,
        snapshotPresent: fp.snapshotPresent,
      },
      errors: pkg.errors as BrowserImportIssue[],
      warnings: pkg.warnings as BrowserImportIssue[],
    });
  }

  const batchIssues: BrowserImportIssue[] = Array.isArray(batch.batchIssues)
    ? (batch.batchIssues as BrowserImportIssue[])
    : [];

  return {
    success: true,
    batch: {
      mode: batch.mode,
      selectedRootName: batch.selectedRootName,
      packageCount: batch.packageCount,
      selectedFileCount: batch.selectedFileCount,
      declaredTotalBytes: batch.declaredTotalBytes,
      validPackageCount: batch.validPackageCount,
      warningPackageCount: batch.warningPackageCount,
      invalidPackageCount: batch.invalidPackageCount,
      totalWarnings: batch.totalWarnings,
      totalErrors: batch.totalErrors,
      mediaValidationMode: 'descriptor_only',
      batchIssues,
      packages,
    },
  };
}
