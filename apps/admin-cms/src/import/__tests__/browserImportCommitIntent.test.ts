import { describe, it, expect } from 'vitest';
import {
  generateBrowserPreviewFingerprint,
  prepareBrowserImportCommitIntent,
} from '../prepareBrowserImportCommitIntent';
import {
  BrowserImportPackagePreview,
  BrowserImportPreviewBatch,
  SelectionManifest,
} from '../browserImportPreviewContract';
import {
  createInitialSelectionState,
  toggleValidPackage,
  toggleWarningAcknowledgement,
  toggleWarningPackageSelection,
  setPreparing,
  setPreparedSuccess,
  setPreparedFailure,
  resetSelectionState,
  browserImportCommitIntentSchema,
} from '../browserImportCommitIntentContract';

function makeMockPreviewBatch(overrides: Partial<BrowserImportPreviewBatch> = {}): BrowserImportPreviewBatch {
  const packages: BrowserImportPackagePreview[] = overrides.packages || [
    {
      packagePath: 'root/p1',
      folderName: 'p1',
      proposedPublicId: 'p1',
      metadataSource: 'xlsx',
      status: 'valid',
      previewMetadata: null,
      filePresence: {
        xlsxPresent: true,
        jsonPresent: false,
        posterImagePresent: true,
        posterPdfPresent: true,
        snapshotPresent: false,
      },
      errors: [],
      warnings: [],
    },
    {
      packagePath: 'root/p2',
      folderName: 'p2',
      proposedPublicId: 'p2',
      metadataSource: 'xlsx',
      status: 'warning',
      previewMetadata: null,
      filePresence: {
        xlsxPresent: true,
        jsonPresent: false,
        posterImagePresent: true,
        posterPdfPresent: true,
        snapshotPresent: false,
      },
      errors: [],
      warnings: [{ code: 'MIME_CONFLICT_WARNING', message: 'MIME conflict', severity: 'warning' }],
    },
    {
      packagePath: 'root/p3',
      folderName: 'p3',
      proposedPublicId: 'p3',
      metadataSource: null,
      status: 'invalid',
      previewMetadata: null,
      filePresence: {
        xlsxPresent: false,
        jsonPresent: false,
        posterImagePresent: false,
        posterPdfPresent: false,
        snapshotPresent: false,
      },
      errors: [{ code: 'PACKAGE_METADATA_MISSING', message: 'Missing metadata', severity: 'error' }],
      warnings: [],
    },
  ];

  const baseInput = {
    selectedRootName: overrides.selectedRootName || 'root',
    fileCount: overrides.selectedFileCount ?? 5,
    declaredTotalBytes: overrides.declaredTotalBytes ?? 1000,
    packages,
  };

  const fingerprint = generateBrowserPreviewFingerprint(baseInput);

  return {
    previewFingerprint: fingerprint,
    mode: 'batch',
    selectedRootName: 'root',
    packageCount: packages.length,
    selectedFileCount: 6,
    declaredTotalBytes: 1200,
    validPackageCount: packages.filter((p) => p.status === 'valid').length,
    warningPackageCount: packages.filter((p) => p.status === 'warning').length,
    invalidPackageCount: packages.filter((p) => p.status === 'invalid').length,
    totalWarnings: 1,
    totalErrors: 1,
    mediaValidationMode: 'descriptor_only',
    batchIssues: [],
    packages,
    ...overrides,
  };
}

import { generateUploadKey } from '../browserSelection';

function makeMockManifest(overrides: Partial<SelectionManifest> = {}): SelectionManifest {
  const defaultPaths = [
    'root/p1/project-details.xlsx',
    'root/p1/poster.png',
    'root/p1/poster.pdf',
    'root/p2/project-details.xlsx',
    'root/p2/poster.png',
    'root/p2/poster.pdf',
  ];

  const defaultDescriptors = defaultPaths.map((p) => {
    let mime = 'text/plain';
    if (p.endsWith('.xlsx')) mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (p.endsWith('.png')) mime = 'image/png';
    else if (p.endsWith('.pdf')) mime = 'application/pdf';
    return {
      uploadKey: generateUploadKey(p),
      originalPath: p,
      fileSizeBytes: 200,
      browserMimeType: mime,
    };
  });

  const descriptors = overrides.descriptors || defaultDescriptors;
  const totalBytes = overrides.declaredTotalBytes ?? descriptors.reduce((acc, d) => acc + d.fileSizeBytes, 0);

  return {
    selectedRootName: 'root',
    fileCount: descriptors.length,
    declaredTotalBytes: totalBytes,
    ignoredSystemFilesCount: 0,
    descriptors,
    ...overrides,
  };
}

describe('Browser Import Commit Intent & Planner Suite', () => {
  describe('Authoritative Fingerprint & Pure Planner', () => {
    it('1. Deterministic fingerprint for equivalent input ordering', () => {
      const inputA = {
        selectedRootName: 'root',
        fileCount: 5,
        declaredTotalBytes: 1000,
        packages: [
          { packagePath: 'root/p1', status: 'valid' as const, errors: [], warnings: [] },
          { packagePath: 'root/p2', status: 'warning' as const, errors: [], warnings: [{ code: 'MIME_CONFLICT' }] },
        ],
      };
      const inputB = {
        selectedRootName: 'root',
        fileCount: 5,
        declaredTotalBytes: 1000,
        packages: [
          { packagePath: 'root/p2', status: 'warning' as const, errors: [], warnings: [{ code: 'MIME_CONFLICT' }] },
          { packagePath: 'root/p1', status: 'valid' as const, errors: [], warnings: [] },
        ],
      };

      const fpA = generateBrowserPreviewFingerprint(inputA);
      const fpB = generateBrowserPreviewFingerprint(inputB);
      expect(fpA).toBe(fpB);
      expect(fpA).toMatch(/^[a-f0-9]{64}$/);
    });

    it('2. Fingerprint changes when an eligibility-relevant value changes', () => {
      const baseInput = {
        selectedRootName: 'root',
        fileCount: 5,
        declaredTotalBytes: 1000,
        packages: [
          { packagePath: 'root/p1', status: 'valid' as const, errors: [], warnings: [] },
        ],
      };
      const fpBase = generateBrowserPreviewFingerprint(baseInput);

      const fpRootChange = generateBrowserPreviewFingerprint({ ...baseInput, selectedRootName: 'other' });
      const fpStatusChange = generateBrowserPreviewFingerprint({
        ...baseInput,
        packages: [{ packagePath: 'root/p1', status: 'invalid' as const, errors: [{ code: 'ERR' }], warnings: [] }],
      });
      const fpCountChange = generateBrowserPreviewFingerprint({ ...baseInput, fileCount: 6 });

      expect(fpRootChange).not.toBe(fpBase);
      expect(fpStatusChange).not.toBe(fpBase);
      expect(fpCountChange).not.toBe(fpBase);
    });

    it('3. Valid-only selection success', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.intent.selectedPackagePaths).toEqual(['root/p1']);
        expect(res.intent.acknowledgedWarningPackagePaths).toEqual([]);
        expect(res.summary.selectedPackageCount).toBe(1);
        expect(res.summary.warningPackageCount).toBe(0);
      }
    });

    it('4. Warning package with explicit acknowledgement success', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1', 'root/p2'],
        acknowledgedWarningPackagePaths: ['root/p2'],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.intent.selectedPackagePaths).toEqual(['root/p1', 'root/p2']);
        expect(res.intent.acknowledgedWarningPackagePaths).toEqual(['root/p2']);
        expect(res.summary.selectedPackageCount).toBe(2);
        expect(res.summary.warningPackageCount).toBe(1);
      }
    });

    it('5. Warning selected without acknowledgement fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p2'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('UNACKNOWLEDGED_WARNING_PACKAGE_SELECTED');
      }
    });

    it('6. Invalid package selection fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p3'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('INVALID_PACKAGE_SELECTED');
      }
    });

    it('7. Unknown selected path fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p999'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('UNKNOWN_SELECTED_PACKAGE_PATH');
      }
    });

    it('8. Unknown acknowledgement path fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: ['root/p999'],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('UNKNOWN_ACKNOWLEDGEMENT_PACKAGE_PATH');
      }
    });

    it('9. Duplicate selected path fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1', 'root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('DUPLICATE_PACKAGE_PATHS');
      }
    });

    it('10. Duplicate acknowledgement path fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1', 'root/p2'],
        acknowledgedWarningPackagePaths: ['root/p2', 'root/p2'],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('DUPLICATE_ACKNOWLEDGEMENT_PATHS');
      }
    });

    it('11. Acknowledgement of a valid package fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: ['root/p1'],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('ACKNOWLEDGEMENT_REJECTED_FOR_NON_WARNING');
      }
    });

    it('12. Acknowledgement of an invalid package fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: ['root/p3'],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('ACKNOWLEDGEMENT_REJECTED_FOR_NON_WARNING');
      }
    });

    it('13. Mismatched root fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest({ selectedRootName: 'different-root' });

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('INVALID_MANIFEST');
      }
    });

    it('14. Mismatched file count fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest({ fileCount: 99 });

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('INVALID_MANIFEST');
      }
    });

    it('15. Mismatched declared byte total fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest({ declaredTotalBytes: 99999 });

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('INVALID_MANIFEST');
      }
    });

    it('16. Stale fingerprint fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: 'f'.repeat(64),
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
      }
    });

    it('17. Empty selection fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: [],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('EMPTY_SELECTION');
      }
    });

    it('18. Output order is deterministic', () => {
      const preview = makeMockPreviewBatch({
        selectedFileCount: 2,
        declaredTotalBytes: 1000,
        packages: [
          {
            packagePath: 'root/p-zebra',
            folderName: 'p-zebra',
            proposedPublicId: 'p-zebra',
            metadataSource: 'xlsx',
            status: 'valid',
            previewMetadata: null,
            filePresence: { xlsxPresent: true, jsonPresent: false, posterImagePresent: true, posterPdfPresent: true, snapshotPresent: false },
            errors: [],
            warnings: [],
          },
          {
            packagePath: 'root/p-alpha',
            folderName: 'p-alpha',
            proposedPublicId: 'p-alpha',
            metadataSource: 'xlsx',
            status: 'valid',
            previewMetadata: null,
            filePresence: { xlsxPresent: true, jsonPresent: false, posterImagePresent: true, posterPdfPresent: true, snapshotPresent: false },
            errors: [],
            warnings: [],
          },
        ],
      });
      const manifest = makeMockManifest({
        descriptors: [
          { uploadKey: generateUploadKey('root/p-zebra/project-details.xlsx'), originalPath: 'root/p-zebra/project-details.xlsx', fileSizeBytes: 500, browserMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          { uploadKey: generateUploadKey('root/p-alpha/project-details.xlsx'), originalPath: 'root/p-alpha/project-details.xlsx', fileSizeBytes: 500, browserMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        ],
        fileCount: 2,
        declaredTotalBytes: 1000,
      });

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p-zebra', 'root/p-alpha'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.intent.selectedPackagePaths).toEqual(['root/p-alpha', 'root/p-zebra']);
      }
    });

    it('19. Unexpected contract fields fail schema validation', () => {
      const invalidIntent = {
        version: 1,
        previewFingerprint: 'a'.repeat(64),
        selectedRootName: 'root',
        fileCount: 5,
        declaredTotalBytes: 1000,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        extraUnrecognizedField: 'malicious',
      };

      const parseRes = browserImportCommitIntentSchema.safeParse(invalidIntent);
      expect(parseRes.success).toBe(false);
    });

    it('20. Unsafe values are not included in public errors', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p3'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.message).toBe('Invalid packages cannot be selected for import.');
        expect(res.message).not.toContain('root/p3');
      }
    });
  });

  describe('Selection State Reducer Unit Tests', () => {
    it('21. Valid packages selected by default, warnings unselected, invalid unselectable', () => {
      const batch = makeMockPreviewBatch();
      const state = createInitialSelectionState(batch);

      expect(state.selectedPackagePaths).toEqual(['root/p1']);
      expect(state.acknowledgedWarningPackagePaths).toEqual([]);
      expect(state.isPreparing).toBe(false);
      expect(state.preparedIntent).toBeNull();
    });

    it('22. Acknowledging a warning does not automatically select it', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateAck = toggleWarningAcknowledgement(initial, 'root/p2', batch.packages);
      expect(stateAck.acknowledgedWarningPackagePaths).toEqual(['root/p2']);
      expect(stateAck.selectedPackagePaths).toEqual(['root/p1']); // Still not selected!
    });

    it('23. Selecting an acknowledged warning succeeds', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateAck = toggleWarningAcknowledgement(initial, 'root/p2', batch.packages);
      const stateSel = toggleWarningPackageSelection(stateAck, 'root/p2', batch.packages);

      expect(stateSel.selectedPackagePaths).toEqual(['root/p1', 'root/p2']);
    });

    it('24. Selecting unacknowledged warning fails silently in state helper', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateSel = toggleWarningPackageSelection(initial, 'root/p2', batch.packages);
      expect(stateSel.selectedPackagePaths).toEqual(['root/p1']);
    });

    it('25. Removing acknowledgement deselects the warning package', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateAck = toggleWarningAcknowledgement(initial, 'root/p2', batch.packages);
      const stateSel = toggleWarningPackageSelection(stateAck, 'root/p2', batch.packages);
      expect(stateSel.selectedPackagePaths).toEqual(['root/p1', 'root/p2']);

      const stateUnAck = toggleWarningAcknowledgement(stateSel, 'root/p2', batch.packages);
      expect(stateUnAck.acknowledgedWarningPackagePaths).toEqual([]);
      expect(stateUnAck.selectedPackagePaths).toEqual(['root/p1']);
    });

    it('26. Selection changes invalidate prepared intent', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);
      const mockIntent = {
        version: 1 as const,
        previewFingerprint: batch.previewFingerprint,
        selectedRootName: 'root',
        fileCount: 5,
        declaredTotalBytes: 1000,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
      };

      const preparedState = setPreparedSuccess(initial, mockIntent);
      expect(preparedState.preparedIntent).not.toBeNull();

      const toggledState = toggleValidPackage(preparedState, 'root/p1', batch.packages);
      expect(toggledState.preparedIntent).toBeNull();
    });

    it('27. Preparation pending blocks duplicate actions', () => {
      const initial = resetSelectionState();
      const statePrep = setPreparing(initial, true);
      expect(statePrep.isPreparing).toBe(true);

      const stateErr = setPreparedFailure(statePrep, 'ERROR');
      expect(stateErr.isPreparing).toBe(false);
      expect(stateErr.preparationErrorCode).toBe('ERROR');
    });
  });
});
