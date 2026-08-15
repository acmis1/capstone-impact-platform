import { browserImportCommitIntentSchema } from './browserImportCommitIntentContract';
import type { BrowserImportCommitIntentResult } from './browserImportCommitIntentContract';
import { runBrowserImportManifestPreflight } from './browserImportPreviewContract';
import type {
  BrowserImportPackagePreview,
  BrowserImportPreviewBatch,
  SelectionManifest,
} from './browserImportPreviewContract';

/**
 * Builds an untrusted client selection intent from an already validated server preview.
 * The staging routes independently re-inspect the uploaded package and verify the canonical
 * preview fingerprint and intent before any persistence occurs.
 */
export function prepareBrowserImportCommitIntentClient(params: {
  manifest: unknown;
  preview: BrowserImportPreviewBatch;
  selectedPackagePaths: string[];
  acknowledgedWarningPackagePaths: string[];
  expectedPreviewFingerprint: string;
}): BrowserImportCommitIntentResult {
  const {
    manifest,
    preview,
    selectedPackagePaths,
    acknowledgedWarningPackagePaths,
    expectedPreviewFingerprint,
  } = params;

  if (!preview || typeof preview !== 'object' || !Array.isArray(preview.packages)) {
    return {
      success: false,
      code: 'INVALID_PREVIEW_STRUCTURE',
      message: 'Preview structure is invalid.',
    };
  }

  if (!preview.adminReference) {
    return {
      success: false,
      code: 'MISSING_ADMIN_REFERENCE',
      message: 'Admin reference dataset cross-check is required before preparing or staging metadata.',
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

  const preflightResult = runBrowserImportManifestPreflight(manifest);
  if (!preflightResult.success) {
    return {
      success: false,
      code: 'INVALID_MANIFEST',
      message: 'Manifest validation failed.',
    };
  }
  const verifiedManifest: SelectionManifest = preflightResult.manifest;

  if (preview.selectedRootName !== verifiedManifest.selectedRootName) {
    return {
      success: false,
      code: 'ROOT_NAME_MISMATCH',
      message: 'Selected root directory does not match preview.',
    };
  }

  if (preview.selectedFileCount !== verifiedManifest.fileCount) {
    return {
      success: false,
      code: 'FILE_COUNT_MISMATCH',
      message: 'File count does not match preview.',
    };
  }

  if (preview.declaredTotalBytes !== verifiedManifest.declaredTotalBytes) {
    return {
      success: false,
      code: 'DECLARED_BYTES_MISMATCH',
      message: 'Declared total bytes do not match preview.',
    };
  }

  if (
    !/^[a-f0-9]{64}$/.test(expectedPreviewFingerprint) ||
    preview.previewFingerprint !== expectedPreviewFingerprint
  ) {
    return {
      success: false,
      code: 'PREVIEW_FINGERPRINT_MISMATCH',
      message: 'Preview state has changed or fingerprint does not match.',
    };
  }

  const previewPaths = preview.packages.map((pkg) => pkg.packagePath);
  if (new Set(previewPaths).size !== previewPaths.length) {
    return {
      success: false,
      code: 'INVALID_PREVIEW_STRUCTURE',
      message: 'Preview contains duplicate package paths.',
    };
  }

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

  for (const packagePath of selectedPackagePaths) {
    if (!packageMap.has(packagePath)) {
      return {
        success: false,
        code: 'UNKNOWN_SELECTED_PACKAGE_PATH',
        message: 'Selected package path does not exist in preview.',
      };
    }
  }

  for (const packagePath of acknowledgedWarningPackagePaths) {
    const pkg = packageMap.get(packagePath);
    if (!pkg) {
      return {
        success: false,
        code: 'UNKNOWN_ACKNOWLEDGEMENT_PACKAGE_PATH',
        message: 'Acknowledged package path does not exist in preview.',
      };
    }
    if (pkg.status !== 'warning') {
      return {
        success: false,
        code: 'ACKNOWLEDGEMENT_REJECTED_FOR_NON_WARNING',
        message: 'Warning acknowledgement is only accepted for warning packages.',
      };
    }
  }

  let warningPackageCount = 0;
  for (const packagePath of selectedPackagePaths) {
    const pkg = packageMap.get(packagePath)!;
    if (pkg.status === 'invalid') {
      return {
        success: false,
        code: 'INVALID_PACKAGE_SELECTED',
        message: 'Invalid packages cannot be selected for import.',
      };
    }
    if (pkg.status === 'warning') {
      if (!acknowledgedWarningPackagePaths.includes(packagePath)) {
        return {
          success: false,
          code: 'UNACKNOWLEDGED_WARNING_PACKAGE_SELECTED',
          message: 'Warning packages must be explicitly acknowledged before selection.',
        };
      }
      warningPackageCount++;
    }
  }

  const sortedSelected = [...selectedPackagePaths].sort((a, b) => a.localeCompare(b));
  const sortedAcknowledged = [...acknowledgedWarningPackagePaths].sort((a, b) => a.localeCompare(b));
  const parsedIntent = browserImportCommitIntentSchema.safeParse({
    version: 1,
    previewFingerprint: preview.previewFingerprint,
    selectedRootName: preview.selectedRootName,
    fileCount: preview.selectedFileCount,
    declaredTotalBytes: preview.declaredTotalBytes,
    selectedPackagePaths: sortedSelected,
    acknowledgedWarningPackagePaths: sortedAcknowledged,
    adminReference: preview.adminReference,
  });

  if (!parsedIntent.success) {
    return {
      success: false,
      code: 'INVALID_COMMIT_INTENT',
      message: 'Generated commit intent failed schema validation.',
    };
  }

  return {
    success: true,
    intent: parsedIntent.data,
    summary: {
      selectedPackageCount: sortedSelected.length,
      warningPackageCount,
    },
  };
}
