import { ManifestPreflightSuccess, ServerDerivedDescriptor } from './browserImportPreviewContract';
import { BrowserImportServerPackage } from './parseBrowserImportPreview';

export type BrowserImportMediaAssetType = 'poster_image' | 'poster_pdf' | 'snapshot_image';

export interface ExpectedBrowserImportMediaFile {
  uploadKey: string;
  packagePath: string;
  projectPublicId: string;
  assetType: BrowserImportMediaAssetType;
  fileName: string;
  fileSizeBytes: number;
  canonicalMimeType: string;
}

const RECOGNIZED_MEDIA_FILENAMES: Record<string, BrowserImportMediaAssetType> = {
  'poster.png': 'poster_image',
  'poster.pdf': 'poster_pdf',
  'snapshot-1.png': 'snapshot_image',
};

export type ResolveExpectedMediaResult =
  | { success: true; files: ExpectedBrowserImportMediaFile[] }
  | { success: false; code: 'UNKNOWN_SELECTED_PACKAGE_PATH' | 'PACKAGE_MISSING_PUBLIC_ID'; message: string };

/**
 * Pure, server-authoritative derivation of the expected media file set for a set of
 * already-validated selected package paths. Never trusts client-declared file lists —
 * the expected set is derived strictly from the resubmitted manifest's descriptors
 * (`preflight.packagesMap`) joined against the resubmitted package analysis.
 */
export function resolveExpectedBrowserImportMedia(params: {
  preflight: Pick<ManifestPreflightSuccess, 'packagesMap'>;
  packages: BrowserImportServerPackage[];
  selectedPackagePaths: string[];
}): ResolveExpectedMediaResult {
  const { preflight, packages, selectedPackagePaths } = params;

  const packageByPath = new Map<string, BrowserImportServerPackage>();
  for (const pkg of packages) {
    packageByPath.set(pkg.packagePath, pkg);
  }

  const files: ExpectedBrowserImportMediaFile[] = [];

  for (const packagePath of selectedPackagePaths) {
    const pkg = packageByPath.get(packagePath);
    if (!pkg) {
      return {
        success: false,
        code: 'UNKNOWN_SELECTED_PACKAGE_PATH',
        message: `Selected package path [${packagePath}] does not exist in the resubmitted analysis.`,
      };
    }

    if (!pkg.proposedPublicId) {
      return {
        success: false,
        code: 'PACKAGE_MISSING_PUBLIC_ID',
        message: `Selected package [${packagePath}] has no resolvable public ID.`,
      };
    }

    const descriptors: ServerDerivedDescriptor[] = preflight.packagesMap.get(packagePath) || [];
    const descriptorByLowerName = new Map<string, ServerDerivedDescriptor>();
    for (const desc of descriptors) {
      descriptorByLowerName.set(desc.fileName.toLowerCase(), desc);
    }

    for (const [lowerName, assetType] of Object.entries(RECOGNIZED_MEDIA_FILENAMES)) {
      const isPresent =
        (assetType === 'poster_image' && pkg.filePresence.posterImagePresent) ||
        (assetType === 'poster_pdf' && pkg.filePresence.posterPdfPresent) ||
        (assetType === 'snapshot_image' && pkg.filePresence.snapshotPresent);

      if (!isPresent) continue;

      const desc = descriptorByLowerName.get(lowerName);
      if (!desc) continue;

      files.push({
        uploadKey: desc.uploadKey,
        packagePath,
        projectPublicId: pkg.proposedPublicId,
        assetType,
        fileName: desc.fileName,
        fileSizeBytes: desc.fileSizeBytes,
        canonicalMimeType: desc.canonicalMimeType,
      });
    }
  }

  return { success: true, files };
}
