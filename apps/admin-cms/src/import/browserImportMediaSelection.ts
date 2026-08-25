import { ManifestPreflightSuccess, ServerDerivedDescriptor } from './browserImportPreviewContract';
import { BrowserImportServerPackage } from './parseBrowserImportPreview';
import {
  parseGalleryFilePosition,
  sortGalleryByPosition,
} from './galleryConvention';
export type BrowserImportMediaAssetType = 'poster_image' | 'poster_pdf' | 'snapshot_image';

export interface ExpectedBrowserImportMediaFile {
  uploadKey: string;
  packagePath: string;
  projectPublicId: string;
  assetType: BrowserImportMediaAssetType;
  fileName: string;
  fileSizeBytes: number;
  canonicalMimeType: string;
  galleryPosition: number | null;
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
};

/**
 * Reads the snapshot alt text out of the authoritative server-reparsed package manifest. Returns
 * `null` rather than a placeholder when the manifest carries nothing usable: a filename, the
 * project title, or the poster accessibility text would all be fabricated accessibility evidence,
 * so a genuinely absent value stays absent and the workflow gates hold the project instead.
 */
function resolveSnapshotAltText(
  pkg: BrowserImportServerPackage,
  position: number,
): string | null {
  const galleryAltTexts = pkg.manifest?.galleryAltTexts;

  if (Array.isArray(galleryAltTexts)) {
    const matched = galleryAltTexts.find(
      (item) => item.position === position,
    );

    if (matched && typeof matched.altText === 'string') {
      const trimmed = matched.altText.trim();

      if (trimmed !== '') {
        return trimmed;
      }
    }
  }

  // Compatibility with the original single-snapshot contract.
  // Only gallery position 1 may fall back to snapshotAltText.
  if (position === 1) {
    const raw = pkg.manifest?.snapshotAltText;

    if (typeof raw === 'string') {
      const trimmed = raw.trim();

      if (trimmed !== '') {
        return trimmed;
      }
    }
  }

  return null;
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
        (assetType === 'poster_pdf' && pkg.filePresence.posterPdfPresent);

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
        galleryPosition: null,
        snapshotAltText: null,
      });
    }

    if (pkg.filePresence.snapshotPresent) {
      const galleryDescriptors = sortGalleryByPosition(
        descriptors
          .map((desc) => {
            const position = parseGalleryFilePosition(desc.fileName);

            if (position === null) {
              return null;
            }

            return {
              position,
              desc,
            };
          })
          .filter(
            (
              item,
            ): item is {
              position: number;
              desc: ServerDerivedDescriptor;
            } => item !== null,
          ),
      );

      for (const galleryItem of galleryDescriptors) {
        const { position, desc } = galleryItem;

        files.push({
          uploadKey: desc.uploadKey,
          packagePath,
          projectPublicId: pkg.proposedPublicId,
          assetType: 'snapshot_image',
          fileName: desc.fileName,
          fileSizeBytes: desc.fileSizeBytes,
          canonicalMimeType: desc.canonicalMimeType,
          galleryPosition: position,
          snapshotAltText: resolveSnapshotAltText(pkg, position),
        });
      }
    }
  }

  return { success: true, files };
}
