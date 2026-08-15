import { createHash } from 'crypto';
import type { CanonicalExpectedMediaFile } from './browserImportMediaStageContract';

/** Computes the authoritative deterministic SHA-256 hash for a canonical media-stage intent. */
export function computeCanonicalMediaIntentHash(params: {
  batchId: string;
  metadataIntentHash: string;
  files: CanonicalExpectedMediaFile[];
}): string {
  const sortedFiles = [...params.files]
    .sort((a, b) => a.packagePath.localeCompare(b.packagePath) || a.assetType.localeCompare(b.assetType))
    .map((file) => ({
      packagePath: file.packagePath,
      projectPublicId: file.projectPublicId,
      assetType: file.assetType,
      fileName: file.fileName,
      fileSizeBytes: file.fileSizeBytes,
      snapshotAltText: file.snapshotAltText ?? null,
    }));

  const canonicalObj = {
    batchId: params.batchId,
    metadataIntentHash: params.metadataIntentHash,
    files: sortedFiles,
  };

  return createHash('sha256').update(JSON.stringify(canonicalObj), 'utf8').digest('hex');
}
