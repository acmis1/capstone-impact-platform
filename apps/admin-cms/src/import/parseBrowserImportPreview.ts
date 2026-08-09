import {
  BROWSER_IMPORT_LIMITS,
  BrowserImportIssue,
  BrowserImportPackagePreview,
  BrowserImportPreviewResponse,
  SelectedFileDescriptor,
  SelectionManifest,
  selectionManifestSchema,
} from './browserImportPreviewContract';
import {
  deriveMimeType,
  generateUploadKey,
  isIgnoredSystemFile,
  normalizeRelativePath,
} from './browserSelection';
import { validateFolderDerivedPublicId } from './publicIdValidation';
import { parseProjectDetailsWorkbook } from './parseProjectDetailsWorkbook';
import { ProjectDetailsWorkbookError } from './projectDetailsWorkbookContract';
import { buildImportPackageManifestFromWorkbook } from './workbookManifestAdapter';
import {
  parseProjectDetailsJson,
  ProjectDetailsJsonError,
} from './parseProjectDetailsJson';
import { validateImportPackage } from './validateImportPackage';
import {
  ImportPackageFileMetadata,
  ImportPackageManifest,
  ImportPackageParseResult,
} from './importTypes';

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

/**
 * Server-side parser and batch validator for browser-selected folder previews.
 * Strictly derives paths, enforces server limits, isolates package previews, and sanitizes errors.
 */
export async function parseBrowserImportPreview(
  rawManifest: unknown,
  uploadedMetadataFiles: Map<string, Buffer>
): Promise<BrowserImportPreviewResponse> {
  // Step 5: Strict Runtime Zod Schema Validation
  const parseResult = selectionManifestSchema.safeParse(rawManifest);
  if (!parseResult.success) {
    throw new BrowserImportPreviewLimitError(
      'MANIFEST_INVALID',
      'Selection manifest is invalid or malformed.',
      400
    );
  }

  const manifest: SelectionManifest = parseResult.data as SelectionManifest;

  // 1. Enforce Server Limits
  if (manifest.descriptors.length > BROWSER_IMPORT_LIMITS.MAX_DESCRIPTORS) {
    throw new BrowserImportPreviewLimitError(
      'DESCRIPTOR_LIMIT_EXCEEDED',
      `Selection contains ${manifest.descriptors.length} files, exceeding the maximum limit of ${BROWSER_IMPORT_LIMITS.MAX_DESCRIPTORS}.`,
      413
    );
  }

  let totalMetadataBytes = 0;
  let metadataFileCount = 0;

  for (const [key, buffer] of uploadedMetadataFiles.entries()) {
    metadataFileCount++;
    totalMetadataBytes += buffer.length;

    const lowerKey = key.toLowerCase();
    if (lowerKey.endsWith('.xlsx') && buffer.length > BROWSER_IMPORT_LIMITS.MAX_XLSX_SIZE_BYTES) {
      throw new BrowserImportPreviewLimitError(
        'XLSX_SIZE_LIMIT_EXCEEDED',
        'An uploaded .xlsx metadata file exceeds the maximum limit of 5 MB.',
        413
      );
    }
    if (lowerKey.endsWith('.json') && buffer.length > BROWSER_IMPORT_LIMITS.MAX_JSON_SIZE_BYTES) {
      throw new BrowserImportPreviewLimitError(
        'JSON_SIZE_LIMIT_EXCEEDED',
        'An uploaded .json metadata file exceeds the maximum limit of 1 MB.',
        413
      );
    }
  }

  if (metadataFileCount > BROWSER_IMPORT_LIMITS.MAX_METADATA_FILES) {
    throw new BrowserImportPreviewLimitError(
      'METADATA_COUNT_LIMIT_EXCEEDED',
      `Number of uploaded metadata files (${metadataFileCount}) exceeds maximum limit of ${BROWSER_IMPORT_LIMITS.MAX_METADATA_FILES}.`,
      413
    );
  }

  if (totalMetadataBytes > BROWSER_IMPORT_LIMITS.MAX_TOTAL_METADATA_BYTES) {
    throw new BrowserImportPreviewLimitError(
      'TOTAL_METADATA_SIZE_LIMIT_EXCEEDED',
      'Combined uploaded metadata size exceeds maximum limit of 25 MB.',
      413
    );
  }

  // Step 5: Server-side path normalization and descriptor derivation
  const validDescriptors: SelectedFileDescriptor[] = [];
  const seenNormPaths = new Set<string>();
  const seenLowerPaths = new Set<string>();
  const seenUploadKeys = new Set<string>();
  const rootSegments = new Set<string>();

  let recomputedTotalBytes = 0;

  for (const desc of manifest.descriptors) {
    const normPath = normalizeRelativePath(desc.originalPath);
    if (!normPath) {
      throw new BrowserImportPreviewLimitError(
        'INVALID_DESCRIPTOR_PATH',
        'Selection contains an invalid or unsafe file path.',
        400
      );
    }

    if (isIgnoredSystemFile(normPath)) {
      continue;
    }

    const lowerPath = normPath.toLowerCase();
    if (seenLowerPaths.has(lowerPath)) {
      throw new BrowserImportPreviewLimitError(
        'DUPLICATE_FILE_PATH',
        'Selection contains duplicate relative file paths.',
        400
      );
    }
    seenNormPaths.add(normPath);
    seenLowerPaths.add(lowerPath);

    const parts = normPath.split('/');
    const derivedFileName = parts[parts.length - 1];
    const lowerName = derivedFileName.toLowerCase();

    if (lowerName === 'project-details.xlsx' && desc.fileSizeBytes > BROWSER_IMPORT_LIMITS.MAX_XLSX_SIZE_BYTES) {
      throw new BrowserImportPreviewLimitError(
        'METADATA_FILE_OVERSIZED',
        `Metadata file ${derivedFileName} exceeds maximum limit of 5 MB.`,
        413
      );
    }
    if (lowerName === 'project.json' && desc.fileSizeBytes > BROWSER_IMPORT_LIMITS.MAX_JSON_SIZE_BYTES) {
      throw new BrowserImportPreviewLimitError(
        'METADATA_FILE_OVERSIZED',
        `Metadata file ${derivedFileName} exceeds maximum limit of 1 MB.`,
        413
      );
    }

    const derivedRoot = parts[0];
    rootSegments.add(derivedRoot);

    const expectedUploadKey = generateUploadKey(normPath);
    if (seenUploadKeys.has(expectedUploadKey)) {
      throw new BrowserImportPreviewLimitError(
        'DUPLICATE_UPLOAD_KEY',
        'Selection contains duplicate upload keys.',
        400
      );
    }
    seenUploadKeys.add(expectedUploadKey);

    // Tamper check on client fields if provided
    if (desc.uploadKey && desc.uploadKey !== expectedUploadKey) {
      throw new BrowserImportPreviewLimitError(
        'DESCRIPTOR_TAMPERED',
        'Submitted descriptor upload key does not match server-recomputed key.',
        400
      );
    }

    if (desc.normalizedPath && desc.normalizedPath !== normPath) {
      throw new BrowserImportPreviewLimitError(
        'DESCRIPTOR_TAMPERED',
        'Submitted descriptor normalized path does not match server-recomputed path.',
        400
      );
    }

    if (desc.fileName && desc.fileName !== derivedFileName) {
      throw new BrowserImportPreviewLimitError(
        'DESCRIPTOR_TAMPERED',
        'Submitted descriptor file name does not match server-recomputed file name.',
        400
      );
    }

    const derivedMime = deriveMimeType(derivedFileName, desc.mimeType).mimeType;
    recomputedTotalBytes += desc.fileSizeBytes;

    validDescriptors.push({
      uploadKey: expectedUploadKey,
      originalPath: desc.originalPath,
      normalizedPath: normPath,
      fileName: derivedFileName,
      fileSizeBytes: desc.fileSizeBytes,
      mimeType: derivedMime,
      packagePath: '', // to be assigned during mode classification
    });
  }

  if (validDescriptors.length === 0) {
    throw new BrowserImportPreviewLimitError(
      'NO_VALID_FILES',
      'The selected folder contains no valid files to preview.',
      422
    );
  }

  // Step 6: Derive Authoritative Root Segment
  if (rootSegments.size > 1) {
    throw new BrowserImportPreviewLimitError(
      'MULTIPLE_ROOT_DIRECTORIES',
      'Selection contains files from multiple root folders.',
      400
    );
  }

  const derivedRootName = Array.from(rootSegments)[0];

  if (manifest.selectedRootName && manifest.selectedRootName !== derivedRootName) {
    throw new BrowserImportPreviewLimitError(
      'ROOT_NAME_MISMATCH',
      'Submitted selected root name does not match path-derived root name.',
      400
    );
  }

  if (manifest.fileCount !== validDescriptors.length) {
    throw new BrowserImportPreviewLimitError(
      'FILE_COUNT_MISMATCH',
      'Submitted file count does not match validated descriptor count.',
      400
    );
  }

  if (manifest.declaredTotalBytes !== recomputedTotalBytes) {
    throw new BrowserImportPreviewLimitError(
      'DECLARED_BYTES_MISMATCH',
      'Submitted total bytes does not match validated sum of file sizes.',
      400
    );
  }

  // Step 6 & 8: Folder Shape Classification & Batch Grouping
  const rootMetadataFiles: SelectedFileDescriptor[] = [];
  const childMetadataFiles: SelectedFileDescriptor[] = [];

  for (const desc of validDescriptors) {
    const parts = desc.normalizedPath.split('/');
    const lowerName = desc.fileName.toLowerCase();
    if (lowerName === 'project-details.xlsx' || lowerName === 'project.json') {
      if (parts.length === 2) {
        rootMetadataFiles.push(desc);
      } else if (parts.length === 3) {
        childMetadataFiles.push(desc);
      }
    }
  }

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
    const maxDepth = Math.max(...validDescriptors.map((d) => d.normalizedPath.split('/').length));
    mode = maxDepth >= 3 ? 'batch' : 'single';
  }

  const batchIssues: BrowserImportIssue[] = [];
  const packageBuckets = new Map<string, SelectedFileDescriptor[]>();

  for (const desc of validDescriptors) {
    const parts = desc.normalizedPath.split('/');

    if (mode === 'single') {
      const pkgPath = derivedRootName;
      desc.packagePath = pkgPath;
      if (!packageBuckets.has(pkgPath)) packageBuckets.set(pkgPath, []);
      packageBuckets.get(pkgPath)!.push(desc);
    } else {
      // Batch Mode
      if (parts.length === 2) {
        // Step 8: Loose files directly under batch root do NOT create package buckets
        batchIssues.push({
          code: 'BATCH_ROOT_LOOSE_FILE',
          message: 'Unrecognized file in batch root folder will be ignored.',
          severity: 'warning',
          fileName: desc.fileName,
        });
      } else {
        const pkgPath = `${parts[0]}/${parts[1]}`;
        desc.packagePath = pkgPath;
        if (!packageBuckets.has(pkgPath)) packageBuckets.set(pkgPath, []);
        packageBuckets.get(pkgPath)!.push(desc);
      }
    }
  }

  if (packageBuckets.size > BROWSER_IMPORT_LIMITS.MAX_PACKAGES) {
    throw new BrowserImportPreviewLimitError(
      'PACKAGE_LIMIT_EXCEEDED',
      `Selected folder contains ${packageBuckets.size} packages, exceeding maximum limit of ${BROWSER_IMPORT_LIMITS.MAX_PACKAGES}.`,
      413
    );
  }

  const packagePreviews: BrowserImportPackagePreview[] = [];
  let validPackageCount = 0;
  let warningPackageCount = 0;
  let invalidPackageCount = 0;
  let totalWarnings = 0;
  let totalErrors = 0;

  // Process packages deterministically sorted by packagePath
  const sortedPackagePaths = Array.from(packageBuckets.keys()).sort((a, b) => a.localeCompare(b));

  for (const pkgPath of sortedPackagePaths) {
    const descList = packageBuckets.get(pkgPath)!.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
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
      // Step 6: Validate proposed public ID derived strictly from folder name
      const publicIdValidation = validateFolderDerivedPublicId(folderName);
      if (!publicIdValidation.valid) {
        errors.push({
          code: 'PACKAGE_INVALID_PUBLIC_ID',
          message: publicIdValidation.message || 'Invalid folder-derived public ID.',
          severity: 'error',
          packagePath: pkgPath,
        });
      }

      // Canonical name map & structural depth check
      const canonicalNamesMap = new Map<string, string>();
      const recognizedFiles = new Map<string, SelectedFileDescriptor>();

      for (const desc of descList) {
        const parts = desc.normalizedPath.split('/');
        const relativeDepth = parts.length - (mode === 'single' ? 1 : 2);
        const fileName = desc.fileName;
        const lowerName = fileName.toLowerCase();

        // Structural check: recognized files at depth > 1 inside package emit structure error
        if (
          relativeDepth > 1 &&
          ['project-details.xlsx', 'project.json', 'poster.png', 'poster.pdf', 'snapshot-1.png'].includes(lowerName)
        ) {
          errors.push({
            code: 'PACKAGE_STRUCTURE_INVALID',
            message: 'Recognized package files must be placed directly in the project package folder.',
            severity: 'error',
            packagePath: pkgPath,
            fileName,
          });
          continue;
        }

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

        if (
          ['project-details.xlsx', 'project.json', 'poster.png', 'poster.pdf', 'snapshot-1.png'].includes(lowerName)
        ) {
          recognizedFiles.set(lowerName, desc);
        } else {
          warnings.push({
            code: 'PACKAGE_UNKNOWN_FILE',
            message: 'Unrecognized file in package root will be ignored.',
            severity: 'warning',
            packagePath: pkgPath,
            fileName,
          });
        }
      }

      filePresence.xlsxPresent = recognizedFiles.has('project-details.xlsx');
      filePresence.jsonPresent = recognizedFiles.has('project.json');
      filePresence.posterImagePresent = recognizedFiles.has('poster.png');
      filePresence.posterPdfPresent = recognizedFiles.has('poster.pdf');
      filePresence.snapshotPresent = recognizedFiles.has('snapshot-1.png');

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

        const lowerName = desc.fileName.toLowerCase();
        if (
          (lowerName === 'poster.png' || lowerName === 'snapshot-1.png') &&
          desc.fileSizeBytes > BROWSER_IMPORT_LIMITS.MAX_IMAGE_SIZE_BYTES
        ) {
          errors.push({
            code: 'FILE_IMAGE_OVERSIZED',
            message: `Image file ${desc.fileName} exceeds size limit of 10 MB.`,
            severity: 'error',
            packagePath: pkgPath,
            fileName: desc.fileName,
          });
        }
        if (lowerName === 'poster.pdf' && desc.fileSizeBytes > BROWSER_IMPORT_LIMITS.MAX_PDF_SIZE_BYTES) {
          errors.push({
            code: 'FILE_PDF_OVERSIZED',
            message: `PDF file ${desc.fileName} exceeds size limit of 25 MB.`,
            severity: 'error',
            packagePath: pkgPath,
            fileName: desc.fileName,
          });
        }
      }

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
            // Step 11: Explicit known error class handling
            if (wbErr instanceof ProjectDetailsWorkbookError && Array.isArray(wbErr.issues)) {
              wbErr.issues.forEach((issue) => {
                const targetList = (issue.severity as string) === 'warning' ? warnings : errors;
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
            // Step 11: Explicit known error class handling
            if (jsonErr instanceof ProjectDetailsJsonError && Array.isArray(jsonErr.issues)) {
              jsonErr.issues.forEach((issue) => {
                const targetList = (issue.severity as string) === 'warning' ? warnings : errors;
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
    } catch (err: unknown) {
      // Step 10: Safe internal logging without raw exceptions or stack traces
      const errCode = err instanceof Error ? err.name : 'UNKNOWN';
      // Log controlled internal code only
      process.stdout.write(`[Browser Import Preview] Package preview failed cleanly: ${errCode}\n`);

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
      selectedRootName: derivedRootName,
      packageCount: packagePreviews.length,
      selectedFileCount: validDescriptors.length,
      declaredTotalBytes: recomputedTotalBytes,
      validPackageCount,
      warningPackageCount,
      invalidPackageCount,
      totalWarnings: totalWarnings + batchIssues.filter((i) => i.severity === 'warning').length,
      totalErrors: totalErrors + batchIssues.filter((i) => i.severity === 'error').length,
      mediaValidationMode: 'descriptor_only',
      batchIssues,
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
