import {
  SelectedFileDescriptor,
  SelectionManifest,
  deriveMimeType,
  isIgnoredSystemFile,
  normalizeRelativePath,
} from './browserSelection';
import { validateFolderDerivedPublicId } from './publicIdValidation';
import { parseProjectDetailsWorkbook } from './parseProjectDetailsWorkbook';
import { buildImportPackageManifestFromWorkbook } from './workbookManifestAdapter';
import { parseProjectDetailsJson } from './parseProjectDetailsJson';
import { validateImportPackage } from './validateImportPackage';
import {
  ImportPackageFileMetadata,
  ImportPackageManifest,
  ImportPackageParseResult,
} from './importTypes';

export interface BrowserImportIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  packagePath?: string;
  fileName?: string;
  fieldName?: string;
  columnName?: string;
  rowNumber?: number;
}

export interface BrowserImportPackagePreview {
  packagePath: string;
  folderName: string;
  proposedPublicId: string;
  metadataSource: 'xlsx' | 'json' | null;
  status: 'valid' | 'warning' | 'invalid';
  previewMetadata: {
    title: string;
    year: string;
    program: string;
    discipline: string;
    groupName: string;
    teamMemberCount: number;
    layoutTemplate: string;
    featuredMedia: string;
  } | null;
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

export interface BrowserImportPreviewResponse {
  success: true;
  batch: {
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
    packages: BrowserImportPackagePreview[];
  };
}

export class BrowserImportPreviewLimitError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 413) {
    super(message);
    this.name = 'BrowserImportPreviewLimitError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// Server limits
const MAX_PACKAGES = 25;
const MAX_DESCRIPTORS = 500;
const MAX_METADATA_FILES = 25;
const MAX_XLSX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_JSON_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_TOTAL_METADATA_BYTES = 25 * 1024 * 1024; // 25 MB

function extractIssuesFromError(err: unknown): BrowserImportIssue[] | null {
  if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
    return (err as { issues: BrowserImportIssue[] }).issues;
  }
  return null;
}

/**
 * Server-side parser and batch validator for browser-selected folder previews.
 */
export async function parseBrowserImportPreview(
  manifest: SelectionManifest,
  uploadedMetadataFiles: Map<string, Buffer>
): Promise<BrowserImportPreviewResponse> {
  if (!manifest || !Array.isArray(manifest.descriptors)) {
    throw new BrowserImportPreviewLimitError('MANIFEST_INVALID', 'Selection manifest is invalid or malformed.', 400);
  }

  // 1. Enforce Server Limits
  if (manifest.descriptors.length > MAX_DESCRIPTORS) {
    throw new BrowserImportPreviewLimitError(
      'DESCRIPTOR_LIMIT_EXCEEDED',
      `Selection contains ${manifest.descriptors.length} files, exceeding the maximum limit of ${MAX_DESCRIPTORS}.`,
      413
    );
  }

  let totalMetadataBytes = 0;
  let metadataFileCount = 0;

  for (const [key, buffer] of uploadedMetadataFiles.entries()) {
    metadataFileCount++;
    totalMetadataBytes += buffer.length;

    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('.xlsx') && buffer.length > MAX_XLSX_SIZE_BYTES) {
      throw new BrowserImportPreviewLimitError(
        'XLSX_SIZE_LIMIT_EXCEEDED',
        `An uploaded .xlsx metadata file exceeds the maximum limit of 5 MB.`,
        413
      );
    }
    if (lowerKey.includes('.json') && buffer.length > MAX_JSON_SIZE_BYTES) {
      throw new BrowserImportPreviewLimitError(
        'JSON_SIZE_LIMIT_EXCEEDED',
        `An uploaded .json metadata file exceeds the maximum limit of 1 MB.`,
        413
      );
    }
  }

  if (metadataFileCount > MAX_METADATA_FILES) {
    throw new BrowserImportPreviewLimitError(
      'METADATA_COUNT_LIMIT_EXCEEDED',
      `Number of uploaded metadata files (${metadataFileCount}) exceeds maximum limit of ${MAX_METADATA_FILES}.`,
      413
    );
  }

  if (totalMetadataBytes > MAX_TOTAL_METADATA_BYTES) {
    throw new BrowserImportPreviewLimitError(
      'TOTAL_METADATA_SIZE_LIMIT_EXCEEDED',
      `Combined uploaded metadata size exceeds maximum limit of 25 MB.`,
      413
    );
  }

  // Filter out system files & normalize
  const validDescriptors: SelectedFileDescriptor[] = [];
  const seenPaths = new Set<string>();

  for (const desc of manifest.descriptors) {
    const norm = normalizeRelativePath(desc.originalPath);
    if (!norm) continue;
    if (isIgnoredSystemFile(norm)) continue;

    // Duplicate exact path check
    if (seenPaths.has(norm)) {
      throw new BrowserImportPreviewLimitError(
        'DUPLICATE_FILE_PATH',
        'Selection contains duplicate relative file paths.',
        400
      );
    }
    seenPaths.add(norm);
    validDescriptors.push({ ...desc, normalizedPath: norm });
  }

  if (validDescriptors.length === 0) {
    throw new BrowserImportPreviewLimitError(
      'NO_VALID_FILES',
      'The selected folder contains no valid files to preview.',
      422
    );
  }

  const selectedRootName = manifest.selectedRootName || validDescriptors[0].normalizedPath.split('/')[0];

  // Group descriptors by package folder
  const rootMetadataFiles: SelectedFileDescriptor[] = [];
  const childMetadataFiles: SelectedFileDescriptor[] = [];

  for (const desc of validDescriptors) {
    const parts = desc.normalizedPath.split('/');
    const fileName = parts[parts.length - 1].toLowerCase();
    if (fileName === 'project-details.xlsx' || fileName === 'project.json') {
      if (parts.length === 2) {
        rootMetadataFiles.push(desc);
      } else if (parts.length === 3) {
        childMetadataFiles.push(desc);
      }
    }
  }

  // Detect mode & global layout ambiguity
  let mode: 'single' | 'batch' = 'single';

  if (rootMetadataFiles.length > 0 && childMetadataFiles.length > 0) {
    throw new BrowserImportPreviewLimitError(
      'PACKAGE_STRUCTURE_AMBIGUOUS',
      'Metadata files were found at both the root level and inside subfolders.',
      422
    );
  }

  if (childMetadataFiles.length > 0) {
    mode = 'batch';
  } else if (rootMetadataFiles.length > 0) {
    mode = 'single';
  } else {
    // Check general depth
    const maxDepth = Math.max(...validDescriptors.map((d) => d.normalizedPath.split('/').length));
    if (maxDepth >= 3) {
      mode = 'batch';
    } else {
      mode = 'single';
    }
  }

  // Partition descriptors into package buckets
  const packageBuckets = new Map<string, SelectedFileDescriptor[]>();

  for (const desc of validDescriptors) {
    const parts = desc.normalizedPath.split('/');
    let pkgPath = '';

    if (mode === 'single') {
      pkgPath = selectedRootName;
    } else {
      // In batch mode, immediate child under root is package folder
      if (parts.length >= 2) {
        pkgPath = `${parts[0]}/${parts[1]}`;
      } else {
        pkgPath = selectedRootName; // root loose file
      }
    }

    if (!packageBuckets.has(pkgPath)) {
      packageBuckets.set(pkgPath, []);
    }
    packageBuckets.get(pkgPath)!.push(desc);
  }

  // Check package count limit
  if (packageBuckets.size > MAX_PACKAGES) {
    throw new BrowserImportPreviewLimitError(
      'PACKAGE_LIMIT_EXCEEDED',
      `Selected folder contains ${packageBuckets.size} packages, exceeding maximum limit of ${MAX_PACKAGES}.`,
      413
    );
  }

  const packagePreviews: BrowserImportPackagePreview[] = [];
  let validPackageCount = 0;
  let warningPackageCount = 0;
  let invalidPackageCount = 0;
  let totalWarnings = 0;
  let totalErrors = 0;

  // Process each package bucket in deterministic order
  const sortedPackagePaths = Array.from(packageBuckets.keys()).sort((a, b) => a.localeCompare(b));

  for (const pkgPath of sortedPackagePaths) {
    const descList = packageBuckets.get(pkgPath)!;
    const folderName = pkgPath.includes('/') ? pkgPath.split('/')[1] : pkgPath;

    const errors: BrowserImportIssue[] = [];
    const warnings: BrowserImportIssue[] = [];

    let metadataSource: 'xlsx' | 'json' | null = null;
    let previewMetadata: BrowserImportPackagePreview['previewMetadata'] = null;

    const filePresence = {
      xlsxPresent: false,
      jsonPresent: false,
      posterImagePresent: false,
      posterPdfPresent: false,
      snapshotPresent: false,
    };

    let currentManifest: ImportPackageManifest | null = null;

    try {
      // Validate proposed public ID
      const publicIdValidation = validateFolderDerivedPublicId(folderName);
      if (!publicIdValidation.valid) {
        errors.push({
          code: 'PACKAGE_INVALID_PUBLIC_ID',
          message: publicIdValidation.message || 'Invalid folder-derived public ID.',
          severity: 'error',
          packagePath: pkgPath,
        });
      }

      // Check case-insensitive duplicate filenames in package
      const canonicalNamesMap = new Map<string, string>();
      const recognizedFiles = new Map<string, SelectedFileDescriptor>();

      for (const desc of descList) {
        const parts = desc.normalizedPath.split('/');
        const relativeDepth = parts.length - (mode === 'single' ? 1 : 2);
        const fileName = parts[parts.length - 1];
        const lowerName = fileName.toLowerCase();

        // Check nested files
        if (relativeDepth > 1) {
          warnings.push({
            code: 'PACKAGE_NESTED_FILE',
            message: 'Nested subfolder files are not supported in package root.',
            severity: 'warning',
            packagePath: pkgPath,
            fileName,
          });
          continue;
        }

        // Case collision check
        if (canonicalNamesMap.has(lowerName) && canonicalNamesMap.get(lowerName) !== fileName) {
          errors.push({
            code: 'PACKAGE_DUPLICATE_CASE_FILE',
            message: 'Multiple files with identical case-insensitive names exist in the package.',
            severity: 'error',
            packagePath: pkgPath,
            fileName,
          });
        }
        canonicalNamesMap.set(lowerName, fileName);

        // Recognized files
        if (
          ['project-details.xlsx', 'project.json', 'poster.png', 'poster.pdf', 'snapshot-1.png'].includes(lowerName)
        ) {
          recognizedFiles.set(lowerName, desc);
        } else {
          // Unknown package file warning (fileName strictly in context field)
          warnings.push({
            code: 'PACKAGE_UNKNOWN_FILE',
            message: 'Unrecognized file in package root will be ignored.',
            severity: 'warning',
            packagePath: pkgPath,
            fileName,
          });
        }
      }

      // Track file presence
      filePresence.xlsxPresent = recognizedFiles.has('project-details.xlsx');
      filePresence.jsonPresent = recognizedFiles.has('project.json');
      filePresence.posterImagePresent = recognizedFiles.has('poster.png');
      filePresence.posterPdfPresent = recognizedFiles.has('poster.pdf');
      filePresence.snapshotPresent = recognizedFiles.has('snapshot-1.png');

      // Check MIME conflicts on descriptors
      for (const [, desc] of recognizedFiles.entries()) {
        const derived = deriveMimeType(desc.fileName, desc.mimeType);
        if (derived.warning) {
          warnings.push({
            code: 'MIME_CONFLICT_WARNING',
            message: derived.warning,
            severity: 'warning',
            packagePath: pkgPath,
            fileName: desc.fileName,
          });
        }
      }

      // Metadata source selection
      if (filePresence.xlsxPresent && filePresence.jsonPresent) {
        errors.push({
          code: 'PACKAGE_MULTIPLE_METADATA_SOURCES',
          message: 'Package contains both project-details.xlsx and project.json. Exactly one metadata source is required.',
          severity: 'error',
          packagePath: pkgPath,
        });
      } else if (filePresence.xlsxPresent) {
        metadataSource = 'xlsx';
        const xlsxDesc = recognizedFiles.get('project-details.xlsx')!;
        const xlsxBuffer = uploadedMetadataFiles.get(xlsxDesc.uploadKey);

        if (!xlsxBuffer) {
          errors.push({
            code: 'PACKAGE_MISSING_METADATA_BLOB',
            message: 'Uploaded metadata content for project-details.xlsx was missing.',
            severity: 'error',
            packagePath: pkgPath,
            fileName: xlsxDesc.fileName,
          });
        } else {
          try {
            const parsedWb = await parseProjectDetailsWorkbook(xlsxBuffer);
            const manifestObj = buildImportPackageManifestFromWorkbook({
              parsedWorkbook: parsedWb,
              publicId: folderName,
            });
            currentManifest = manifestObj;
            previewMetadata = extractPreviewMetadata(manifestObj);

            // Collect workbook warnings & errors
            if (parsedWb.warnings) {
              parsedWb.warnings.forEach((w) =>
                warnings.push({
                  code: w.code,
                  message: w.message,
                  severity: 'warning',
                  packagePath: pkgPath,
                  fieldName: w.fieldName,
                  columnName: w.columnName,
                  rowNumber: w.rowNumber,
                })
              );
            }
          } catch (wbErr: unknown) {
            const extractedIssues = extractIssuesFromError(wbErr);
            if (extractedIssues) {
              extractedIssues.forEach((issue) => {
                const targetList = issue.severity === 'warning' ? warnings : errors;
                targetList.push({
                  code: issue.code,
                  message: issue.message,
                  severity: issue.severity,
                  packagePath: pkgPath,
                  fieldName: issue.fieldName,
                  columnName: issue.columnName,
                  rowNumber: issue.rowNumber,
                });
              });
            } else {
              errors.push({
                code: 'WORKBOOK_MALFORMED',
                message: 'The uploaded file could not be read as a valid .xlsx workbook.',
                severity: 'error',
                packagePath: pkgPath,
              });
            }
          }
        }
      } else if (filePresence.jsonPresent) {
        metadataSource = 'json';
        const jsonDesc = recognizedFiles.get('project.json')!;
        const jsonBuffer = uploadedMetadataFiles.get(jsonDesc.uploadKey);

        if (!jsonBuffer) {
          errors.push({
            code: 'PACKAGE_MISSING_METADATA_BLOB',
            message: 'Uploaded metadata content for project.json was missing.',
            severity: 'error',
            packagePath: pkgPath,
            fileName: jsonDesc.fileName,
          });
        } else {
          try {
            const parsedJson = parseProjectDetailsJson(jsonBuffer, folderName);
            currentManifest = parsedJson.manifest;
            previewMetadata = extractPreviewMetadata(parsedJson.manifest);
            parsedJson.warnings.forEach((w) =>
              warnings.push({
                code: w.code,
                message: w.message,
                severity: 'warning',
                packagePath: pkgPath,
                fieldName: w.fieldName,
              })
            );
          } catch (jsonErr: unknown) {
            const extractedIssues = extractIssuesFromError(jsonErr);
            if (extractedIssues) {
              extractedIssues.forEach((issue) => {
                const targetList = issue.severity === 'warning' ? warnings : errors;
                targetList.push({
                  code: issue.code,
                  message: issue.message,
                  severity: issue.severity,
                  packagePath: pkgPath,
                  fieldName: issue.fieldName,
                });
              });
            } else {
              errors.push({
                code: 'PACKAGE_MALFORMED_JSON',
                message: 'The metadata JSON file could not be parsed.',
                severity: 'error',
                packagePath: pkgPath,
              });
            }
          }
        }
      } else {
        errors.push({
          code: 'PACKAGE_METADATA_MISSING',
          message: 'Package contains no metadata file. Required project-details.xlsx or project.json is missing.',
          severity: 'error',
          packagePath: pkgPath,
        });
      }

      // Package Validation via validateImportPackage
      if (currentManifest) {
        const posterImgDesc = recognizedFiles.get('poster.png');
        const posterPdfDesc = recognizedFiles.get('poster.pdf');
        const snapshotDesc = recognizedFiles.get('snapshot-1.png');

        const descriptorParseResult: ImportPackageParseResult<ImportPackageFileMetadata> = {
          manifest: currentManifest,
          posterImage: posterImgDesc
            ? {
                fileName: posterImgDesc.fileName,
                fileSizeBytes: posterImgDesc.fileSizeBytes,
                mimeType: deriveMimeType(posterImgDesc.fileName, posterImgDesc.mimeType).mimeType,
              }
            : null,
          posterPdf: posterPdfDesc
            ? {
                fileName: posterPdfDesc.fileName,
                fileSizeBytes: posterPdfDesc.fileSizeBytes,
                mimeType: deriveMimeType(posterPdfDesc.fileName, posterPdfDesc.mimeType).mimeType,
              }
            : null,
          snapshot1: snapshotDesc
            ? {
                fileName: snapshotDesc.fileName,
                fileSizeBytes: snapshotDesc.fileSizeBytes,
                mimeType: deriveMimeType(snapshotDesc.fileName, snapshotDesc.mimeType).mimeType,
              }
            : null,
        };

        const valResult = validateImportPackage(descriptorParseResult);

        valResult.errors.forEach((e) =>
          errors.push({
            code: e.ruleCode,
            message: e.message,
            severity: 'error',
            packagePath: pkgPath,
            fieldName: e.fieldName,
          })
        );

        valResult.warnings.forEach((w) =>
          warnings.push({
            code: w.ruleCode,
            message: w.message,
            severity: 'warning',
            packagePath: pkgPath,
            fieldName: w.fieldName,
          })
        );
      }
    } catch {
      // Safe fallback for unexpected package exception
      errors.push({
        code: 'PACKAGE_PREVIEW_FAILED',
        message: 'The project package could not be previewed.',
        severity: 'error',
        packagePath: pkgPath,
      });
    }

    const packageStatus: 'valid' | 'warning' | 'invalid' =
      errors.length > 0 ? 'invalid' : warnings.length > 0 ? 'warning' : 'valid';

    if (packageStatus === 'valid') validPackageCount++;
    if (packageStatus === 'warning') warningPackageCount++;
    if (packageStatus === 'invalid') invalidPackageCount++;

    totalErrors += errors.length;
    totalWarnings += warnings.length;

    packagePreviews.push({
      packagePath: pkgPath,
      folderName,
      proposedPublicId: folderName,
      metadataSource,
      status: packageStatus,
      previewMetadata,
      filePresence,
      errors,
      warnings,
    });
  }

  return {
    success: true,
    batch: {
      mode,
      selectedRootName,
      packageCount: packagePreviews.length,
      selectedFileCount: validDescriptors.length,
      declaredTotalBytes: manifest.declaredTotalBytes || 0,
      validPackageCount,
      warningPackageCount,
      invalidPackageCount,
      totalWarnings,
      totalErrors,
      mediaValidationMode: 'descriptor_only',
      packages: packagePreviews,
    },
  };
}

function extractPreviewMetadata(manifest: ImportPackageManifest) {
  return {
    title: manifest.title || '',
    year: manifest.year || '',
    program: manifest.program || manifest.studyProgram || '',
    discipline: manifest.discipline || '',
    groupName: manifest.groupName || '',
    teamMemberCount: Array.isArray(manifest.teamMembers) ? manifest.teamMembers.length : 0,
    layoutTemplate: String(manifest.layoutConfig?.templateId || 'poster_showcase'),
    featuredMedia: String(manifest.layoutConfig?.featuredMedia || 'poster'),
  };
}
