import { createHash } from 'crypto';
import type { CanonicalExpectedMediaFile } from './browserImportMediaStageContract';

/** Computes the authoritative deterministic SHA-256 hash for a canonical media-stage intent. */
export function computeCanonicalMediaIntentHash(params: {
  batchId: string;
  metadataIntentHash: string;
  files: CanonicalExpectedMediaFile[];
}): string {
  const sortedFiles = [...params.files]
    .sort(
      (a, b) =>
        a.packagePath.localeCompare(b.packagePath) ||
        a.assetType.localeCompare(b.assetType) ||
        (a.galleryPosition ?? 0) - (b.galleryPosition ?? 0) ||
        a.fileName.localeCompare(b.fileName)
    )
    .map((file) => ({
      packagePath: file.packagePath,
      projectPublicId: file.projectPublicId,
      assetType: file.assetType,
      fileName: file.fileName,
      fileSizeBytes: file.fileSizeBytes,
      galleryPosition: file.galleryPosition,
      snapshotAltText: file.snapshotAltText ?? null,
      // Present in the canonical object only when declared, so a batch completed before the
      // text-equivalent contract existed still converges on its recorded intent when retried with
      // the identical (undeclared) package, while any declaration changes the intent.
      ...(file.snapshotContentKind ? { snapshotContentKind: file.snapshotContentKind } : {}),
      ...(file.snapshotFullText ? { snapshotFullText: file.snapshotFullText } : {}),
    }));

  const canonicalObj = {
    batchId: params.batchId,
    metadataIntentHash: params.metadataIntentHash,
    files: sortedFiles,
  };

  return createHash('sha256').update(JSON.stringify(canonicalObj), 'utf8').digest('hex');
}
