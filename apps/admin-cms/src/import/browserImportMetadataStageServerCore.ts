import { createHash } from 'crypto';
import type { BrowserImportCommitIntent } from './browserImportCommitIntentContract';

/** Computes the authoritative deterministic SHA-256 hash for a canonical commit intent. */
export function computeCanonicalIntentHash(intent: BrowserImportCommitIntent): string {
  const canonicalObj = {
    version: intent.version,
    previewFingerprint: intent.previewFingerprint,
    selectedRootName: intent.selectedRootName,
    fileCount: intent.fileCount,
    declaredTotalBytes: intent.declaredTotalBytes,
    selectedPackagePaths: [...intent.selectedPackagePaths].sort((a, b) => a.localeCompare(b)),
    acknowledgedWarningPackagePaths: [...intent.acknowledgedWarningPackagePaths].sort((a, b) => a.localeCompare(b)),
    ...(intent.adminReference ? { adminReference: intent.adminReference } : {}),
  };

  return createHash('sha256').update(JSON.stringify(canonicalObj), 'utf8').digest('hex');
}
