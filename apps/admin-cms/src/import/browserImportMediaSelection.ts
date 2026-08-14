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
  /**
   * Text alternative for a `snapshot_image`, derived here from the server-reparsed package manifest
   * and never from anything the browser sends. `null` for every other asset type, and for a legacy
   * `project.json` snapshot whose manifest carries no alt text — that row is registered with a NULL
   * alt and held by the downstream workflow gates until staff supply one.
   *
   * The poster image keeps its project-level `accessibilityText`; it is deliberately not duplicated
   * onto the media asset.
   */
  snapshotAltText: string | null;
}

const RECOGNIZED_MEDIA_FILENAMES: Record<string, BrowserImportMediaAssetType> = {
  'poster.png': 'poster_image',
  'poster.pdf': 'poster_pdf',
  'snapshot-1.png': 'snapshot_image',
};

/**
 * Reads the snapshot alt text out of the authoritative server-reparsed package manifest. Returns
 * `null` rather than a placeholder when the manifest carries nothing usable: a filename, the
 * project title, or the poster accessibility text would all be fabricated accessibility evidence,
 * so a genuinely absent value stays absent and the workflow gates hold the project instead.
 */
function resolveSnapshotAltText(pkg: BrowserImportServerPackage): string | null {
  const raw = pkg.manifest?.snapshotAltText;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

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
        snapshotAltText: assetType === 'snapshot_image' ? resolveSnapshotAltText(pkg) : null,
      });
    }
  }

  return { success: true, files };
}
