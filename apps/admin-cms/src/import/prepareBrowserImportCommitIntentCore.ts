import { createHash } from 'crypto';
import {
  browserImportCommitIntentSchema,
} from './browserImportCommitIntentContract';
import type {
  BrowserImportCommitIntentResult,
} from './browserImportCommitIntentContract';
import {
  adminReferenceIntentsSemanticallyEqual,
} from './adminReferenceReconciliationCore';
import { runBrowserImportManifestPreflight } from './browserImportPreviewContract';
import type {
  BrowserImportPackagePreview,
  BrowserImportPreviewBatch,
  SelectionManifest,
} from './browserImportPreviewContract';

/**
 * Generates an authoritative, deterministic SHA-256 preview fingerprint for a preview batch.
 */
export function generateBrowserPreviewFingerprint(input: {
  selectedRootName: string;
  fileCount: number;
  declaredTotalBytes: number;
  packages: Array<{
    packagePath: string;
    status: 'valid' | 'warning' | 'invalid';
    errors: Array<{ code: string }>;
    warnings: Array<{ code: string }>;
  }>;
  adminReference?: {
    workbookFingerprint: string;
    worksheet: string;
    matchMappings: Array<{ canonicalField: string; referenceColumn: string }>;
    comparisonMappings: Array<{ canonicalField: string; referenceColumn: string }>;
    reconciliationContractVersion: string;
  };
}): string {
  const sortedPackages = [...input.packages]
    .sort((a, b) => a.packagePath.localeCompare(b.packagePath))
    .map((pkg) => {
      const errorCodes = [...pkg.errors].map((e) => e.code).sort();
      const warningCodes = [...pkg.warnings].map((w) => w.code).sort();
      return {
        packagePath: pkg.packagePath,
        status: pkg.status,
        errorCodes,
        warningCodes,
      };
    });

  const canonicalObj = {
    selectedRootName: input.selectedRootName,
    fileCount: input.fileCount,
    declaredTotalBytes: input.declaredTotalBytes,
    packages: sortedPackages,
    ...(input.adminReference ? { adminReference: input.adminReference } : {}),
  };

  return createHash('sha256').update(JSON.stringify(canonicalObj), 'utf8').digest('hex');
}

export type {
  BrowserImportCommitIntentErrorCode,
  BrowserImportCommitIntentResult,
} from './browserImportCommitIntentContract';

export function prepareBrowserImportCommitIntent(params: {
  manifest: unknown;
  preview: BrowserImportPreviewBatch;
  selectedPackagePaths: string[];
  acknowledgedWarningPackagePaths: string[];
  expectedPreviewFingerprint: string;
  adminReference?: {
    workbookFingerprint: string;
    worksheet: string;
    matchMappings: Array<{ canonicalField: string; referenceColumn: string }>;
    comparisonMappings: Array<{ canonicalField: string; referenceColumn: string }>;
    reconciliationContractVersion: 'admin-reference-reconciliation-v1';
  };
}): BrowserImportCommitIntentResult {
  const {
    manifest,
    preview,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths,
    expectedPreviewFingerprint,
    adminReference,
  } = params;

  // 1. Structure check on preview
  if (!preview || typeof preview !== 'object' || !Array.isArray(preview.packages)) {
    return {
      success: false,
      code: 'INVALID_PREVIEW_STRUCTURE',
      message: 'Preview structure is invalid.',
    };
  }

  // Derive Admin Reference intent from the authoritative server preview if omitted.
  if (!preview.adminReference) {
    return {
      success: false,
      code: 'MISSING_ADMIN_REFERENCE',
      message: 'Admin reference dataset cross-check is required before preparing or staging metadata.',
    };
  }
  if (
    adminReference &&
    !adminReferenceIntentsSemanticallyEqual(adminReference, preview.adminReference)
  ) {
    return {
      success: false,
      code: 'ADMIN_REFERENCE_EVIDENCE_MISMATCH',
      message: 'Admin reference evidence does not match the authoritative preview.',
    };
  }
  if (
    preview.batchIssues.some(
      (issue) => issue.severity === 'error' && issue.code.startsWith('ADMIN_REFERENCE_')
    )
  ) {
    return {
      success: false,
      code: 'ADMIN_REFERENCE_INVALID',
      message: 'The Admin reference dataset is invalid for this reconciliation operation.',
    };
  }
  const effectiveAdminReference = preview.adminReference;

  // 2. Strict preflight check on manifest
  const preflightRes = runBrowserImportManifestPreflight(manifest);
  if (!preflightRes.success) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Manifest validation failed.',
    };
  }
  const verifiedManifest: SelectionManifest = preflightRes.manifest;

  // 3. Root name match
  if (preview.selectedRootName !== verifiedManifest.selectedRootName) {
    return {
      success: false,
      code: 'ROOT_NAME_MISMATCH',
      message: 'Selected root directory does not match preview.',
    };
  }

  // 4. File count match
  if (preview.selectedFileCount !== verifiedManifest.fileCount) {
    return {
      success: false,
      code: 'FILE_COUNT_MISMATCH',
      message: 'File count does not match preview.',
    };
  }

  // 5. Declared total bytes match
  if (preview.declaredTotalBytes !== verifiedManifest.declaredTotalBytes) {
    return {
      success: false,
      code: 'DECLARED_BYTES_MISMATCH',
      message: 'Declared total bytes do not match preview.',
    };
  }

  // 6. Expected and authoritative preview fingerprint match & self-consistency check
  const recomputedFingerprint = generateBrowserPreviewFingerprint({
    selectedRootName: preview.selectedRootName,
    fileCount: preview.selectedFileCount,
    declaredTotalBytes: preview.declaredTotalBytes,
    packages: preview.packages,
    adminReference: effectiveAdminReference,
  });

  if (
    !expectedPreviewFingerprint ||
    preview.previewFingerprint !== recomputedFingerprint ||
    expectedPreviewFingerprint !== recomputedFingerprint
  ) {
    return {
      success: false,
      code: 'PREVIEW_FINGERPRINT_MISMATCH',
      message: 'Preview state has changed or fingerprint does not match.',
    };
  }
  const authoritativeFingerprint = recomputedFingerprint;

  // 7. Preview package paths uniqueness check
  const previewPaths = preview.packages.map((p) => p.packagePath);
  if (new Set(previewPaths).size !== previewPaths.length) {
    return {
      success: false,
      code: 'INVALID_PREVIEW_STRUCTURE',
      message: 'Preview contains duplicate package paths.',
    };
  }

  // 8 & 9. Uniqueness checks on selected and acknowledged paths
  if (new Set(selectedPackagePaths).size !== selectedPackagePaths.length) {
    return {
      success: false,
      code: 'DUPLICATE_PACKAGE_PATHS',
      message: 'Selection contains duplicate package paths.',
    };
  }
  if (new Set(acknowledgedWarningPackagePaths).size !== acknowledgedWarningPackagePaths.length) {
    return {
      success: false,
      code: 'DUPLICATE_ACKNOWLEDGEMENT_PATHS',
      message: 'Acknowledgements contain duplicate package paths.',
    };
  }

  // 17. At least one package selected
  if (selectedPackagePaths.length === 0) {
    return {
      success: false,
      code: 'EMPTY_SELECTION',
      message: 'At least one package must be selected.',
    };
  }

  const packageMap = new Map<string, BrowserImportPackagePreview>();
  for (const pkg of preview.packages) {
    packageMap.set(pkg.packagePath, pkg);
  }

  // 10 & 11. Path existence checks
  for (const path of selectedPackagePaths) {
    if (!packageMap.has(path)) {
      return {
        success: false,
        code: 'UNKNOWN_SELECTED_PACKAGE_PATH',
        message: 'Selected package path does not exist in preview.',
      };
    }
  }
  for (const path of acknowledgedWarningPackagePaths) {
    if (!packageMap.has(path)) {
      return {
        success: false,
        code: 'UNKNOWN_ACKNOWLEDGEMENT_PACKAGE_PATH',
        message: 'Acknowledged package path does not exist in preview.',
      };
    }
  }

  // 14, 15. Validation of acknowledgements (accepted ONLY for warning packages)
  for (const path of acknowledgedWarningPackagePaths) {
    const pkg = packageMap.get(path)!;
    if (pkg.status !== 'warning') {
      return {
        success: false,
        code: 'ACKNOWLEDGEMENT_REJECTED_FOR_NON_WARNING',
        message: 'Warning acknowledgement is only accepted for warning packages.',
      };
    }
  }

  // 12 & 13. Validation of selected package eligibility
  let warningPackageCount = 0;
  for (const path of selectedPackagePaths) {
    const pkg = packageMap.get(path)!;
    if (pkg.status === 'invalid') {
      return {
        success: false,
        code: 'INVALID_PACKAGE_SELECTED',
        message: 'Invalid packages cannot be selected for import.',
      };
    }
    if (pkg.status === 'warning') {
      if (!acknowledgedWarningPackagePaths.includes(path)) {
        return {
          success: false,
          code: 'UNACKNOWLEDGED_WARNING_PACKAGE_SELECTED',
          message: 'Warning packages must be explicitly acknowledged before selection.',
        };
      }
      warningPackageCount++;
    }
  }

  // 18. Deterministic sorting of output arrays
  const sortedSelected = [...selectedPackagePaths].sort((a, b) => a.localeCompare(b));
  const sortedAcked = [...acknowledgedWarningPackagePaths].sort((a, b) => a.localeCompare(b));

  const candidateIntent = {
    version: 1 as const,
    previewFingerprint: authoritativeFingerprint,
    selectedRootName: preview.selectedRootName,
    fileCount: preview.selectedFileCount,
    declaredTotalBytes: preview.declaredTotalBytes,
    selectedPackagePaths: sortedSelected,
    acknowledgedWarningPackagePaths: sortedAcked,
    adminReference: effectiveAdminReference,
  };

  // Schema validation pass
  const schemaParse = browserImportCommitIntentSchema.safeParse(candidateIntent);
  if (!schemaParse.success) {
    return {
      success: false,
      code: 'INVALID_COMMIT_INTENT',
      message: 'Generated commit intent failed schema validation.',
    };
  }

  return {
    success: true,
    intent: schemaParse.data,
    summary: {
      selectedPackageCount: sortedSelected.length,
      warningPackageCount,
    },
  };
}
