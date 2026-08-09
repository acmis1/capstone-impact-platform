import {
  BrowserImportPreparationErrorCode,
  BrowserImportSelectionState,
  setPreparedFailure,
  setPreparedSuccess,
  setPreparing,
} from './browserImportCommitIntentContract';
import {
  BrowserImportCommitIntentResult,
  prepareBrowserImportCommitIntent,
} from './prepareBrowserImportCommitIntent';
import { BrowserImportPreviewBatch } from './browserImportPreviewContract';

export interface BrowserImportPreparationSnapshot {
  previewFingerprint: string;
  selectedPackagePaths: string[];
  acknowledgedWarningPackagePaths: string[];
}

export interface BrowserImportPreparationLock {
  current: boolean;
}

export interface RunBrowserImportPreparationParams {
  lock: BrowserImportPreparationLock;
  currentState: BrowserImportSelectionState;
  previewResult: BrowserImportPreviewBatch;
  manifestCache: unknown;
  getCurrentState: () => BrowserImportSelectionState;
  setSelectionState: (updater: (prev: BrowserImportSelectionState) => BrowserImportSelectionState) => void;
  yieldControl?: () => Promise<void>;
  prepareOverride?: (params: {
    manifest: unknown;
    preview: BrowserImportPreviewBatch;
    selectedPackagePaths: string[];
    acknowledgedWarningPackagePaths: string[];
    expectedPreviewFingerprint: string;
  }) => BrowserImportCommitIntentResult;
}

export function isSnapshotEqual(
  a: BrowserImportPreparationSnapshot,
  b: BrowserImportPreparationSnapshot
): boolean {
  if (a.previewFingerprint !== b.previewFingerprint) return false;
  if (a.selectedPackagePaths.length !== b.selectedPackagePaths.length) return false;
  if (!a.selectedPackagePaths.every((p, i) => p === b.selectedPackagePaths[i])) return false;
  if (a.acknowledgedWarningPackagePaths.length !== b.acknowledgedWarningPackagePaths.length) return false;
  if (!a.acknowledgedWarningPackagePaths.every((p, i) => p === b.acknowledgedWarningPackagePaths[i])) return false;
  return true;
}

export function defaultYieldControl(): Promise<void> {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
  return Promise.resolve();
}

export async function runBrowserImportPreparation(
  params: RunBrowserImportPreparationParams
): Promise<void> {
  const {
    lock,
    currentState,
    previewResult,
    manifestCache,
    getCurrentState,
    setSelectionState,
    yieldControl = defaultYieldControl,
    prepareOverride = prepareBrowserImportCommitIntent,
  } = params;

  if (!previewResult || !manifestCache || currentState.isPreparing || lock.current) {
    return;
  }

  lock.current = true;

  try {
    if (currentState.selectedPackagePaths.length === 0) {
      setSelectionState((prev) => setPreparedFailure(prev, 'EMPTY_SELECTION'));
      return;
    }

    if (currentState.previewFingerprint !== previewResult.previewFingerprint) {
      setSelectionState((prev) => setPreparedFailure(prev, 'PREVIEW_FINGERPRINT_MISMATCH'));
      return;
    }

    const snapshot: BrowserImportPreparationSnapshot = {
      previewFingerprint: currentState.previewFingerprint,
      selectedPackagePaths: [...currentState.selectedPackagePaths],
      acknowledgedWarningPackagePaths: [...currentState.acknowledgedWarningPackagePaths],
    };

    setSelectionState((prev) => setPreparing(prev, true));

    await yieldControl();

    const result = prepareOverride({
      manifest: manifestCache,
      preview: previewResult,
      selectedPackagePaths: snapshot.selectedPackagePaths,
      acknowledgedWarningPackagePaths: snapshot.acknowledgedWarningPackagePaths,
      expectedPreviewFingerprint: snapshot.previewFingerprint,
    });

    const latestState = getCurrentState();
    const latestSnapshot: BrowserImportPreparationSnapshot = {
      previewFingerprint: latestState.previewFingerprint,
      selectedPackagePaths: latestState.selectedPackagePaths,
      acknowledgedWarningPackagePaths: latestState.acknowledgedWarningPackagePaths,
    };

    if (!isSnapshotEqual(snapshot, latestSnapshot)) {
      setSelectionState((prev) => setPreparedFailure(prev, 'PREVIEW_FINGERPRINT_MISMATCH'));
      return;
    }

    if (result.success) {
      setSelectionState((prev) => setPreparedSuccess(prev, result.intent));
    } else {
      const mapErrorCode = (code: string): BrowserImportPreparationErrorCode => {
        if (code === 'EMPTY_SELECTION') return 'EMPTY_SELECTION';
        if (code === 'PREVIEW_FINGERPRINT_MISMATCH') return 'PREVIEW_FINGERPRINT_MISMATCH';
        return 'INVALID_SELECTION';
      };
      setSelectionState((prev) => setPreparedFailure(prev, mapErrorCode(result.code)));
    }
  } catch {
    setSelectionState((prev) => setPreparedFailure(prev, 'UNEXPECTED_PREPARATION_FAILURE'));
  } finally {
    lock.current = false;
  }
}
