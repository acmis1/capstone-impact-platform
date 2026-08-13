import {
  BROWSER_IMPORT_LIMITS,
  BrowserImportIssue,
  BrowserImportPackagePreview,
  BrowserImportPreviewResponse,
  ManifestPreflightSuccess,
  SelectionManifest,
  ServerDerivedDescriptor,
  runBrowserImportManifestPreflight,
} from './browserImportPreviewContract';
import { isIgnoredSystemFile } from './browserSelection';
import { validateFolderDerivedPublicId } from './publicIdValidation';
import { parseProjectDetailsWorkbook } from './parseProjectDetailsWorkbook';
import { ProjectDetailsWorkbookError } from './projectDetailsWorkbookContract';
import { buildImportPackageManifestFromWorkbook } from './workbookManifestAdapter';
import {
  parseProjectDetailsJson,
  ProjectDetailsJsonError,
} from './parseProjectDetailsJson';
import { validateImportPackage } from './validateImportPackage';
import { generateBrowserPreviewFingerprint } from './prepareBrowserImportCommitIntent';
import {
  ImportPackageFileMetadata,
  ImportPackageManifest,
  ImportPackageParseResult,
} from './importTypes';

import {
  AdminReferenceMappingConfig,
  computeAdminReferenceWorkbookFingerprint,
  parseAdminReferenceWorksheet,
  reconcilePackagesAgainstAdminReference,
} from './adminReferenceReconciliation';
import { AdminReferenceIntent } from './browserImportCommitIntentContract';

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

export interface AdminReferenceAnalysisOptions {
  referenceFileBuffer: Buffer;
  mapping: AdminReferenceMappingConfig;
}

export interface BrowserImportServerPackage {
  packagePath: string;
  folderName: string;
  proposedPublicId: string;
  status: 'valid' | 'warning' | 'invalid';
  metadataSource: 'xlsx' | 'json' | null;
  manifest: ImportPackageManifest | null;
  filePresence: {
    xlsxPresent: boolean;
    jsonPresent: boolean;
    posterImagePresent: boolean;
    posterPdfPresent: boolean;
    snapshotPresent: boolean;
  };
  reconciliation?: BrowserImportPackagePreview['reconciliation'];
  errors: BrowserImportIssue[];
  warnings: BrowserImportIssue[];
}

export interface BrowserImportServerAnalysis {
  preview: BrowserImportPreviewResponse;
  packages: BrowserImportServerPackage[];
}

export async function analyzeBrowserImportServer(
  manifestOrPreflight: unknown | ManifestPreflightSuccess,
  uploadedMetadataFiles: Map<string, Buffer>,
  adminReferenceOptions?: AdminReferenceAnalysisOptions
): Promise<BrowserImportServerAnalysis> {
  let preflight: ManifestPreflightSuccess;

  if (
    manifestOrPreflight &&
    typeof manifestOrPreflight === 'object' &&
    (manifestOrPreflight as ManifestPreflightSuccess).success === true &&
    (manifestOrPreflight as ManifestPreflightSuccess).derivedDescriptors
  ) {
    preflight = manifestOrPreflight as ManifestPreflightSuccess;
  } else {
    // Parser callers from older server-only tests may include derivable fields.
    // The HTTP route always passes the strict wire object to the same preflight.
    const rawManifest = stripLegacyDerivedDescriptorFields(manifestOrPreflight);
    const res = runBrowserImportManifestPreflight(rawManifest);
    if (!res.success) {
      throw new BrowserImportPreviewLimitError(res.code, res.message, res.httpStatus);
    }
    preflight = res;
  }

  const manifest: SelectionManifest = preflight.manifest;
  const derivedDescriptors = preflight.derivedDescriptors;
  const derivedRootName = preflight.rootPath;

  const validDescriptors: ServerDerivedDescriptor[] = derivedDescriptors
    .filter((d) => !isIgnoredSystemFile(d.normalizedPath))
    .map((d) => ({
      uploadKey: d.uploadKey,
      originalPath: d.originalPath,
      normalizedPath: d.normalizedPath,
      fileName: d.fileName,
      fileSizeBytes: d.fileSizeBytes,
      browserMimeType: d.browserMimeType,
      canonicalMimeType: d.canonicalMimeType,
      mimeConflict: d.mimeConflict,
      packagePath: d.packagePath,
    }));

  if (validDescriptors.length === 0) {
    throw new BrowserImportPreviewLimitError(
      'NO_VALID_FILES',
      'The selected folder contains no valid files to preview.',
      422
    );
  }

  // Step 6 & 8: Folder Shape Classification & Batch Grouping
  const rootMetadataFiles: ServerDerivedDescriptor[] = [];
  const childMetadataFiles: ServerDerivedDescriptor[] = [];

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
  const packageBuckets = new Map<string, ServerDerivedDescriptor[]>();

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
  const serverPackages: BrowserImportServerPackage[] = [];

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
      const recognizedFiles = new Map<string, ServerDerivedDescriptor>();

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

      filePresence.posterImagePresent = recognizedFiles.has('poster.png');
      filePresence.posterPdfPresent = recognizedFiles.has('poster.pdf');
      filePresence.snapshotPresent = recognizedFiles.has('snapshot-1.png');

      const xlsxPresent = recognizedFiles.has('project-details.xlsx');
      const jsonPresent = recognizedFiles.has('project.json');

      filePresence.xlsxPresent = xlsxPresent;
      filePresence.jsonPresent = jsonPresent;

      for (const [, desc] of recognizedFiles.entries()) {
        if (desc.mimeConflict) {
          warnings.push({
            code: 'MIME_CONFLICT_WARNING',
            message: 'The browser-reported MIME type did not match the canonical file type. The canonical type was used for preview validation.',
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
            message: `Image file ${desc.fileName} exceeds size limit of 5 MB.`,
            severity: 'error',
            packagePath: pkgPath,
            fileName: desc.fileName,
          });
        }
        if (lowerName === 'poster.pdf' && desc.fileSizeBytes > BROWSER_IMPORT_LIMITS.MAX_PDF_SIZE_BYTES) {
          errors.push({
            code: 'FILE_PDF_OVERSIZED',
            message: `PDF file ${desc.fileName} exceeds size limit of 20 MB.`,
            severity: 'error',
            packagePath: pkgPath,
            fileName: desc.fileName,
          });
        }
      }

      if (xlsxPresent && jsonPresent) {
        errors.push({
          code: 'PACKAGE_MULTIPLE_METADATA_SOURCES',
          message: 'Package contains both project-details.xlsx and project.json. Exactly one metadata source is required.',
          severity: 'error',
          packagePath: pkgPath,
        });
      } else if (xlsxPresent) {
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
      } else if (jsonPresent) {
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
                mimeType: posterImgDesc.canonicalMimeType,
              }
            : null,
          posterPdf: posterPdfDesc
            ? {
                fileName: posterPdfDesc.fileName,
                fileSizeBytes: posterPdfDesc.fileSizeBytes,
                mimeType: posterPdfDesc.canonicalMimeType,
              }
            : null,
          snapshot1: snapshotDesc
            ? {
                fileName: snapshotDesc.fileName,
                fileSizeBytes: snapshotDesc.fileSizeBytes,
                mimeType: snapshotDesc.canonicalMimeType,
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

    serverPackages.push({
      packagePath: pkgPath,
      folderName,
      proposedPublicId: folderName,
      status: packageStatus,
      metadataSource,
      manifest: currentManifest,
      filePresence,
      errors,
      warnings,
    });
  }

  let adminReferenceIntentObj: AdminReferenceIntent | undefined = undefined;

  if (adminReferenceOptions) {
    const { referenceFileBuffer, mapping } = adminReferenceOptions;
    const refFingerprint = computeAdminReferenceWorkbookFingerprint(referenceFileBuffer);
    const parsedRefRows = await parseAdminReferenceWorksheet(referenceFileBuffer, mapping);

    const reconRes = reconcilePackagesAgainstAdminReference({
      packages: serverPackages.map((sp) => ({
        packagePath: sp.packagePath,
        manifest: sp.manifest || {},
      })),
      referenceRows: parsedRefRows,
      mapping,
    });

    for (let i = 0; i < packagePreviews.length; i++) {
      const pkgPreview = packagePreviews[i];
      const serverPkg = serverPackages[i];
      const recResult = reconRes.packageResults.get(pkgPreview.packagePath);

      if (recResult) {
        pkgPreview.reconciliation = {
          status: recResult.status,
          matchedRowNumber: recResult.matchedRowNumber,
          mismatchedFields: recResult.mismatchedFields,
        };
        serverPkg.reconciliation = pkgPreview.reconciliation;

        if (recResult.status !== 'RECONCILED') {
          if (pkgPreview.status === 'valid') validPackageCount--;
          if (pkgPreview.status === 'warning') warningPackageCount--;
          if (pkgPreview.status !== 'invalid') invalidPackageCount++;
          pkgPreview.status = 'invalid';
          serverPkg.status = 'invalid';

          recResult.issues.forEach((issue) => {
            pkgPreview.errors.push(issue);
            serverPkg.errors.push(issue);
            totalErrors++;
          });
        }
      }
    }

    adminReferenceIntentObj = {
      workbookFingerprint: refFingerprint,
      worksheet: mapping.worksheet,
      matchMappings: mapping.matchMappings,
      comparisonMappings: mapping.comparisonMappings,
      reconciliationContractVersion: 'admin-reference-reconciliation-v1',
    };
  }

  const previewFingerprint = generateBrowserPreviewFingerprint({
    selectedRootName: derivedRootName,
    fileCount: validDescriptors.length,
    declaredTotalBytes: manifest.declaredTotalBytes,
    packages: packagePreviews,
    adminReference: adminReferenceIntentObj,
  });

  const preview: BrowserImportPreviewResponse = {
    success: true,
    batch: {
      previewFingerprint,
      mode,
      selectedRootName: derivedRootName,
      packageCount: packagePreviews.length,
      selectedFileCount: validDescriptors.length,
      declaredTotalBytes: manifest.declaredTotalBytes,
      validPackageCount,
      warningPackageCount,
      invalidPackageCount,
      totalWarnings: totalWarnings + batchIssues.filter((i) => i.severity === 'warning').length,
      totalErrors: totalErrors + batchIssues.filter((i) => i.severity === 'error').length,
      mediaValidationMode: 'descriptor_only',
      batchIssues,
      packages: packagePreviews,
      ...(adminReferenceIntentObj ? { adminReference: adminReferenceIntentObj } : {}),
    },
  };

  return { preview, packages: serverPackages };
}

/**
 * Server-side parser and batch validator for browser-selected folder previews.
 * Strictly derives paths, enforces server limits, isolates package previews, and sanitizes errors.
 */
export async function parseBrowserImportPreview(
  manifestOrPreflight: unknown | ManifestPreflightSuccess,
  uploadedMetadataFiles: Map<string, Buffer>,
  adminReferenceOptions?: AdminReferenceAnalysisOptions
): Promise<BrowserImportPreviewResponse> {
  const { preview } = await analyzeBrowserImportServer(
    manifestOrPreflight,
    uploadedMetadataFiles,
    adminReferenceOptions
  );
  return preview;
}

function stripLegacyDerivedDescriptorFields(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const manifest = raw as Record<string, unknown>;
  if (!Array.isArray(manifest.descriptors)) return raw;
  return {
    ...manifest,
    descriptors: manifest.descriptors.map((descriptor) => {
      if (!descriptor || typeof descriptor !== 'object') return descriptor;
      const wire = { ...(descriptor as Record<string, unknown>) };
      delete wire.normalizedPath;
      delete wire.fileName;
      delete wire.packagePath;
      return wire;
    }),
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
