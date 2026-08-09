import { z } from 'zod';
import { MEDIA_VALIDATION_LIMITS } from '../storage/mediaValidation';
import {
  generateUploadKey,
  normalizeRelativePath,
} from './browserSelection';

/**
 * Shared Server & Client Limits
 */
export const BROWSER_IMPORT_LIMITS = {
  MAX_PACKAGES: 25,
  MAX_DESCRIPTORS: 500,
  MAX_METADATA_FILES: 25,
  MAX_XLSX_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
  MAX_JSON_SIZE_BYTES: 1 * 1024 * 1024, // 1 MB
  MAX_IMAGE_SIZE_BYTES: MEDIA_VALIDATION_LIMITS.MAX_IMAGE_SIZE_BYTES, // 5 MB
  MAX_PDF_SIZE_BYTES: MEDIA_VALIDATION_LIMITS.MAX_PDF_SIZE_BYTES, // 20 MB
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
 * Wire Selected File Descriptor Interface (submitted by client)
 */
export interface SelectedFileDescriptor {
  uploadKey: string;
  originalPath: string;
  fileSizeBytes: number;
  mimeType: string;
}

/**
 * Server-Derived Internal Descriptor Interface
 */
export interface ServerDerivedDescriptor {
  uploadKey: string;
  originalPath: string;
  normalizedPath: string;
  fileName: string;
  fileSizeBytes: number;
  canonicalMimeType: string;
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

export interface BrowserImportPreviewErrorResponse {
  success: false;
  code: string;
  error: string;
}

/**
 * Strict Zod Schemas for Runtime Request Validation
 */
export const selectedFileDescriptorSchema = z
  .object({
    uploadKey: z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_KEY),
    originalPath: z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_PATH),
    fileSizeBytes: z.number().int().nonnegative().finite(),
    mimeType: z.string().max(BROWSER_IMPORT_LIMITS.MAX_STRING_MIME),
  })
  .strict();

export const selectionManifestSchema = z
  .object({
    selectedRootName: z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_NAME),
    fileCount: z.number().int().nonnegative().finite(),
    declaredTotalBytes: z.number().int().nonnegative().finite(),
    ignoredSystemFilesCount: z.number().int().nonnegative().finite(),
    descriptors: z
      .array(selectedFileDescriptorSchema)
      .max(BROWSER_IMPORT_LIMITS.MAX_DESCRIPTORS),
  })
  .strict();

/**
 * Server-Side Manifest Preflight Evaluation Result
 */
export interface ManifestPreflightSuccess {
  success: true;
  manifest: SelectionManifest;
  derivedDescriptors: ServerDerivedDescriptor[];
  expectedMetadataKeys: Map<string, { desc: ServerDerivedDescriptor; isXlsx: boolean }>;
  packagesMap: Map<string, ServerDerivedDescriptor[]>;
  batchMode: 'single' | 'batch';
  rootPath: string;
}

export interface ManifestPreflightFailure {
  success: false;
  code: string;
  message: string;
  httpStatus: number;
}

export type ManifestPreflightResult = ManifestPreflightSuccess | ManifestPreflightFailure;

/**
 * Pure Server-Side Manifest Preflight Evaluator
 */
export function runBrowserImportManifestPreflight(rawManifest: unknown): ManifestPreflightResult {
  const zodResult = selectionManifestSchema.safeParse(rawManifest);
  if (!zodResult.success) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Selection manifest is invalid or malformed.',
      httpStatus: 400,
    };
  }

  const manifest = zodResult.data as SelectionManifest;
  if (manifest.descriptors.length === 0) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Selection manifest contains zero descriptors.',
      httpStatus: 400,
    };
  }

  if (manifest.fileCount !== manifest.descriptors.length) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Selection manifest file count does not match descriptors.',
      httpStatus: 400,
    };
  }

  const derivedDescriptors: ServerDerivedDescriptor[] = [];
  const seenNormPaths = new Set<string>();
  const seenUploadKeys = new Set<string>();

  let calculatedBytes = 0;

  for (const desc of manifest.descriptors) {
    const normPath = normalizeRelativePath(desc.originalPath);
    if (!normPath) {
      return {
        success: false,
        code: 'INVALID_MANIFEST',
        message: 'Manifest contains invalid or unsafe relative path.',
        httpStatus: 400,
      };
    }

    const expectedUploadKey = generateUploadKey(normPath);
    if (desc.uploadKey && desc.uploadKey !== expectedUploadKey) {
      return {
        success: false,
        code: 'INVALID_MANIFEST',
        message: 'Submitted descriptor upload key does not match server-recomputed key.',
        httpStatus: 400,
      };
    }

    const parts = normPath.split('/');
    const derivedFileName = parts[parts.length - 1];
    if (seenNormPaths.has(normPath)) {
      return {
        success: false,
        code: 'DUPLICATE_UPLOAD_FIELD',
        message: 'Selection contains duplicate relative file paths.',
        httpStatus: 400,
      };
    }
    seenNormPaths.add(normPath);

    if (seenUploadKeys.has(expectedUploadKey)) {
      return {
        success: false,
        code: 'DUPLICATE_UPLOAD_FIELD',
        message: 'Upload key collision detected.',
        httpStatus: 400,
      };
    }
    seenUploadKeys.add(expectedUploadKey);

    calculatedBytes += desc.fileSizeBytes;

    // Determine package path
    let packagePath = parts[0];
    if (parts.length > 2) {
      packagePath = parts.slice(0, 2).join('/');
    }

    derivedDescriptors.push({
      uploadKey: expectedUploadKey,
      originalPath: desc.originalPath,
      normalizedPath: normPath,
      fileName: derivedFileName,
      fileSizeBytes: desc.fileSizeBytes,
      canonicalMimeType: desc.mimeType,
      packagePath,
    });
  }

  if (manifest.descriptors.length !== derivedDescriptors.length) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Descriptor count mismatch.',
      httpStatus: 400,
    };
  }

  if (manifest.declaredTotalBytes !== calculatedBytes) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Declared total bytes mismatch.',
      httpStatus: 400,
    };
  }

  // Derive common root
  const rootPaths = Array.from(new Set(derivedDescriptors.map((d) => d.normalizedPath.split('/')[0])));
  if (rootPaths.length !== 1) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Multiple root directories detected in selection.',
      httpStatus: 400,
    };
  }
  const rootPath = rootPaths[0];

  if (manifest.selectedRootName !== rootPath) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Selected root name does not match derived directory root.',
      httpStatus: 400,
    };
  }

  // Group files into packages
  const packagesMap = new Map<string, ServerDerivedDescriptor[]>();
  let metadataFileCount = 0;
  let totalMetadataBytes = 0;

  for (const desc of derivedDescriptors) {
    const parts = desc.normalizedPath.split('/');
    let pkgPath = rootPath;
    if (parts.length > 2) {
      pkgPath = `${rootPath}/${parts[1]}`;
    }

    if (!packagesMap.has(pkgPath)) {
      packagesMap.set(pkgPath, []);
    }
    packagesMap.get(pkgPath)!.push(desc);

    const lowerName = desc.fileName.toLowerCase();
    if (lowerName === 'project-details.xlsx' || lowerName === 'project.json') {
      metadataFileCount++;
      totalMetadataBytes += desc.fileSizeBytes;

      if (lowerName === 'project-details.xlsx' && desc.fileSizeBytes > BROWSER_IMPORT_LIMITS.MAX_XLSX_SIZE_BYTES) {
        return {
          success: false,
          code: 'METADATA_LIMIT_EXCEEDED',
          message: 'Metadata XLSX file exceeds size limit.',
          httpStatus: 413,
        };
      }
      if (lowerName === 'project.json' && desc.fileSizeBytes > BROWSER_IMPORT_LIMITS.MAX_JSON_SIZE_BYTES) {
        return {
          success: false,
          code: 'METADATA_LIMIT_EXCEEDED',
          message: 'Metadata JSON file exceeds size limit.',
          httpStatus: 413,
        };
      }
    }
  }

  if (metadataFileCount > BROWSER_IMPORT_LIMITS.MAX_METADATA_FILES) {
    return {
      success: false,
      code: 'METADATA_LIMIT_EXCEEDED',
      message: 'Metadata file count exceeds limit.',
      httpStatus: 413,
    };
  }

  if (totalMetadataBytes > BROWSER_IMPORT_LIMITS.MAX_TOTAL_METADATA_BYTES) {
    return {
      success: false,
      code: 'METADATA_LIMIT_EXCEEDED',
      message: 'Total metadata size exceeds 25 MB limit.',
      httpStatus: 413,
    };
  }

  // Determine batch mode
  const isBatchMode = derivedDescriptors.some((d) => d.normalizedPath.split('/').length > 2);
  const effectivePackagePaths = isBatchMode
    ? Array.from(packagesMap.keys()).filter((p) => p !== rootPath)
    : [rootPath];

  if (effectivePackagePaths.length > BROWSER_IMPORT_LIMITS.MAX_PACKAGES) {
    return {
      success: false,
      code: 'METADATA_LIMIT_EXCEEDED',
      message: 'Package count exceeds maximum limit of 25.',
      httpStatus: 413,
    };
  }

  const expectedMetadataKeys = new Map<string, { desc: ServerDerivedDescriptor; isXlsx: boolean }>();
  for (const desc of derivedDescriptors) {
    const lowerName = desc.fileName.toLowerCase();
    if (lowerName === 'project-details.xlsx' || lowerName === 'project.json') {
      expectedMetadataKeys.set(desc.uploadKey, { desc, isXlsx: lowerName === 'project-details.xlsx' });
    }
  }

  return {
    success: true,
    manifest,
    derivedDescriptors,
    expectedMetadataKeys,
    packagesMap,
    batchMode: isBatchMode ? 'batch' : 'single',
    rootPath,
  };
}

function isValidIssue(issue: unknown): issue is BrowserImportIssue {
  if (!issue || typeof issue !== 'object') return false;
  const o = issue as Record<string, unknown>;
  if (typeof o.code !== 'string' || o.code.length > BROWSER_IMPORT_LIMITS.MAX_STRING_NAME || typeof o.message !== 'string' || o.message.length > BROWSER_IMPORT_LIMITS.MAX_STRING_PATH) return false;
  if (o.severity !== 'error' && o.severity !== 'warning') return false;
  if (o.packagePath !== undefined && (typeof o.packagePath !== 'string' || o.packagePath.length > BROWSER_IMPORT_LIMITS.MAX_STRING_PATH)) return false;
  if (o.fileName !== undefined && (typeof o.fileName !== 'string' || o.fileName.length > BROWSER_IMPORT_LIMITS.MAX_STRING_NAME)) return false;
  if (o.fieldName !== undefined && (typeof o.fieldName !== 'string' || o.fieldName.length > BROWSER_IMPORT_LIMITS.MAX_STRING_NAME)) return false;
  if (o.columnName !== undefined && (typeof o.columnName !== 'string' || o.columnName.length > BROWSER_IMPORT_LIMITS.MAX_STRING_NAME)) return false;
  if (o.rowNumber !== undefined && (typeof o.rowNumber !== 'number' || !Number.isInteger(o.rowNumber) || o.rowNumber < 0)) return false;
  return true;
}

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
  if (typeof batch.packageCount !== 'number' || !Number.isInteger(batch.packageCount) || batch.packageCount < 0) return null;
  if (typeof batch.selectedFileCount !== 'number' || !Number.isInteger(batch.selectedFileCount) || batch.selectedFileCount < 0) return null;
  if (typeof batch.declaredTotalBytes !== 'number' || !Number.isInteger(batch.declaredTotalBytes) || batch.declaredTotalBytes < 0) return null;
  if (typeof batch.validPackageCount !== 'number' || !Number.isInteger(batch.validPackageCount) || batch.validPackageCount < 0) return null;
  if (typeof batch.warningPackageCount !== 'number' || !Number.isInteger(batch.warningPackageCount) || batch.warningPackageCount < 0) return null;
  if (typeof batch.invalidPackageCount !== 'number' || !Number.isInteger(batch.invalidPackageCount) || batch.invalidPackageCount < 0) return null;
  if (typeof batch.totalWarnings !== 'number' || !Number.isInteger(batch.totalWarnings) || batch.totalWarnings < 0) return null;
  if (typeof batch.totalErrors !== 'number' || !Number.isInteger(batch.totalErrors) || batch.totalErrors < 0) return null;
  if (batch.mediaValidationMode !== 'descriptor_only') return null;
  if (!Array.isArray(batch.packages)) return null;

  if (batch.packageCount !== batch.packages.length) return null;
  if (batch.validPackageCount + batch.warningPackageCount + batch.invalidPackageCount !== batch.packageCount) return null;

  if (Array.isArray(batch.batchIssues)) {
    for (const issue of batch.batchIssues) {
      if (!isValidIssue(issue)) return null;
    }
  } else if (batch.batchIssues !== undefined) {
    return null;
  }

  const packages: BrowserImportPackagePreview[] = [];
  let calculatedWarnings = 0;
  let calculatedErrors = 0;

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

    for (const err of pkg.errors) {
      if (!isValidIssue(err)) return null;
      if ((err as BrowserImportIssue).severity !== 'error') return null;
      calculatedErrors++;
    }
    for (const warn of pkg.warnings) {
      if (!isValidIssue(warn)) return null;
      if ((warn as BrowserImportIssue).severity !== 'warning') return null;
      calculatedWarnings++;
    }
    if ((pkg.status === 'valid' && (pkg.errors.length || pkg.warnings.length)) ||
      (pkg.status === 'warning' && (pkg.errors.length || !pkg.warnings.length)) ||
      (pkg.status === 'invalid' && !pkg.errors.length)) return null;

    let previewMetadata: BrowserImportPreviewMetadata | null = null;
    if (pkg.previewMetadata !== null && pkg.previewMetadata !== undefined) {
      if (typeof pkg.previewMetadata !== 'object') return null;
      const pm = pkg.previewMetadata as Record<string, unknown>;

      if (
        typeof pm.title !== 'string' ||
        typeof pm.year !== 'string' ||
        typeof pm.program !== 'string' ||
        typeof pm.discipline !== 'string' ||
        typeof pm.groupName !== 'string' ||
        typeof pm.teamMemberCount !== 'number' ||
        !Number.isInteger(pm.teamMemberCount) ||
        pm.teamMemberCount < 0 ||
        typeof pm.layoutTemplate !== 'string' ||
        typeof pm.featuredMedia !== 'string'
      ) {
        return null;
      }

      previewMetadata = {
        title: pm.title,
        year: pm.year,
        program: pm.program,
        discipline: pm.discipline,
        groupName: pm.groupName,
        teamMemberCount: pm.teamMemberCount,
        layoutTemplate: pm.layoutTemplate,
        featuredMedia: pm.featuredMedia,
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
  for (const issue of batchIssues) {
    if (issue.severity === 'error') calculatedErrors++;
    else calculatedWarnings++;
  }
  if (batch.totalWarnings !== calculatedWarnings || batch.totalErrors !== calculatedErrors) return null;

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
