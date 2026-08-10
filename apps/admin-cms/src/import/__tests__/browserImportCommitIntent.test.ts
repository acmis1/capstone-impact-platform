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
  BrowserImportSelectionState,
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
import {
  BrowserImportPreparationLock,
  runBrowserImportPreparation,
} from '../browserImportPreparationController';
import { generateUploadKey } from '../browserSelection';
import { readFileSync } from 'fs';
import { join } from 'path';

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
    fileCount: overrides.selectedFileCount ?? 6,
    declaredTotalBytes: overrides.declaredTotalBytes ?? 1200,
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
  describe('Authoritative Fingerprint Integrity & Self-Consistency', () => {
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

    it('3. Altering a package status while retaining the old fingerprint fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();
      const oldFingerprint = preview.previewFingerprint;

      // Tamper status of p1 to invalid without recomputing fingerprint
      preview.packages[0].status = 'invalid';
      preview.packages[0].errors = [{ code: 'TAMPERED', message: 'tampered', severity: 'error' }];

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: oldFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
      }
    });

    it('4. Altering a package path while retaining the old fingerprint fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();
      const oldFingerprint = preview.previewFingerprint;

      // Tamper packagePath of p1
      preview.packages[0].packagePath = 'root/tampered-p1';

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/tampered-p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: oldFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
      }
    });

    it('5. Altering warning/error eligibility codes while retaining the old fingerprint fails', () => {
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();
      const oldFingerprint = preview.previewFingerprint;

      // Inject extra error code into package
      preview.packages[1].warnings.push({ code: 'NEW_WARNING_CODE', message: 'msg', severity: 'warning' });

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1', 'root/p2'],
        acknowledgedWarningPackagePaths: ['root/p2'],
        expectedPreviewFingerprint: oldFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('PREVIEW_FINGERPRINT_MISMATCH');
      }
    });
  });

  describe('Pure Planner Mismatch & Validation Branches', () => {
    it('6. Valid-only selection success', () => {
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

    it('7. Warning package with explicit acknowledgement success', () => {
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

    it('8. ROOT_NAME_MISMATCH branch is reached and returned when root names mismatch', () => {
      const preview = makeMockPreviewBatch({ selectedRootName: 'preview-root' });

      // Build manifest matching preview's root name 'preview-root' so preflight succeeds
      const descriptors = [
        { uploadKey: generateUploadKey('preview-root/p1/project-details.xlsx'), originalPath: 'preview-root/p1/project-details.xlsx', fileSizeBytes: 200, browserMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { uploadKey: generateUploadKey('preview-root/p1/poster.png'), originalPath: 'preview-root/p1/poster.png', fileSizeBytes: 200, browserMimeType: 'image/png' },
      ];
      const manifest: SelectionManifest = {
        selectedRootName: 'manifest-root-mismatched',
        fileCount: 2,
        declaredTotalBytes: 400,
        ignoredSystemFilesCount: 0,
        descriptors,
      };

      // Alter manifest descriptors root to manifest-root-mismatched so manifest preflight passes internally
      manifest.descriptors = [
        { uploadKey: generateUploadKey('manifest-root-mismatched/p1/project-details.xlsx'), originalPath: 'manifest-root-mismatched/p1/project-details.xlsx', fileSizeBytes: 200, browserMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { uploadKey: generateUploadKey('manifest-root-mismatched/p1/poster.png'), originalPath: 'manifest-root-mismatched/p1/poster.png', fileSizeBytes: 200, browserMimeType: 'image/png' },
      ];

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('ROOT_NAME_MISMATCH');
      }
    });

    it('9. FILE_COUNT_MISMATCH branch is reached and returned when file counts mismatch', () => {
      const preview = makeMockPreviewBatch({ selectedFileCount: 6 });

      // Build valid manifest with fileCount 5
      const descriptors = [
        { uploadKey: generateUploadKey('root/p1/project-details.xlsx'), originalPath: 'root/p1/project-details.xlsx', fileSizeBytes: 200, browserMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { uploadKey: generateUploadKey('root/p1/poster.png'), originalPath: 'root/p1/poster.png', fileSizeBytes: 200, browserMimeType: 'image/png' },
      ];
      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 2,
        declaredTotalBytes: 400,
        ignoredSystemFilesCount: 0,
        descriptors,
      };

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('FILE_COUNT_MISMATCH');
      }
    });

    it('10. DECLARED_BYTES_MISMATCH branch is reached and returned when byte totals mismatch', () => {
      const preview = makeMockPreviewBatch({ declaredTotalBytes: 99999, selectedFileCount: 2 });

      const descriptors = [
        { uploadKey: generateUploadKey('root/p1/project-details.xlsx'), originalPath: 'root/p1/project-details.xlsx', fileSizeBytes: 200, browserMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { uploadKey: generateUploadKey('root/p1/poster.png'), originalPath: 'root/p1/poster.png', fileSizeBytes: 200, browserMimeType: 'image/png' },
      ];
      const manifest: SelectionManifest = {
        selectedRootName: 'root',
        fileCount: 2,
        declaredTotalBytes: 400,
        ignoredSystemFilesCount: 0,
        descriptors,
      };

      const res = prepareBrowserImportCommitIntent({
        manifest,
        preview,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
        expectedPreviewFingerprint: preview.previewFingerprint,
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('DECLARED_BYTES_MISMATCH');
      }
    });

    it('11. Warning selected without acknowledgement fails', () => {
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

    it('12. Invalid package selection fails', () => {
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

    it('13. Unknown selected path fails', () => {
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

    it('14. Unknown acknowledgement path fails', () => {
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

    it('15. Duplicate selected path fails', () => {
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

    it('16. Duplicate acknowledgement path fails', () => {
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

    it('17. Acknowledgement of a valid package fails', () => {
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

    it('18. Acknowledgement of an invalid package fails', () => {
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

    it('19. Stale fingerprint fails', () => {
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

    it('20. Empty selection fails', () => {
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

    it('21. Output order is deterministic', () => {
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

    it('22. Unexpected contract fields fail schema validation', () => {
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

    it('23. Unsafe values are not included in public errors', () => {
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

  describe('Selection State Reducer & Controller Unit Tests', () => {
    it('24. Valid packages selected by default, warnings unselected, invalid unselectable', () => {
      const batch = makeMockPreviewBatch();
      const state = createInitialSelectionState(batch);

      expect(state.selectedPackagePaths).toEqual(['root/p1']);
      expect(state.acknowledgedWarningPackagePaths).toEqual([]);
      expect(state.isPreparing).toBe(false);
      expect(state.preparedIntent).toBeNull();
    });

    it('25. Valid toggle', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateDeselected = toggleValidPackage(initial, 'root/p1', batch.packages);
      expect(stateDeselected.selectedPackagePaths).toEqual([]);

      const stateReselected = toggleValidPackage(stateDeselected, 'root/p1', batch.packages);
      expect(stateReselected.selectedPackagePaths).toEqual(['root/p1']);
    });

    it('26. Acknowledging a warning does not automatically select it', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateAck = toggleWarningAcknowledgement(initial, 'root/p2', batch.packages);
      expect(stateAck.acknowledgedWarningPackagePaths).toEqual(['root/p2']);
      expect(stateAck.selectedPackagePaths).toEqual(['root/p1']); // Still not selected!
    });

    it('27. Selecting an acknowledged warning succeeds', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateAck = toggleWarningAcknowledgement(initial, 'root/p2', batch.packages);
      const stateSel = toggleWarningPackageSelection(stateAck, 'root/p2', batch.packages);

      expect(stateSel.selectedPackagePaths).toEqual(['root/p1', 'root/p2']);
    });

    it('28. Selecting unacknowledged warning fails silently in state helper', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateSel = toggleWarningPackageSelection(initial, 'root/p2', batch.packages);
      expect(stateSel.selectedPackagePaths).toEqual(['root/p1']);
    });

    it('29. Removing acknowledgement deselects the warning package', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateAck = toggleWarningAcknowledgement(initial, 'root/p2', batch.packages);
      const stateSel = toggleWarningPackageSelection(stateAck, 'root/p2', batch.packages);
      expect(stateSel.selectedPackagePaths).toEqual(['root/p1', 'root/p2']);

      const stateUnAck = toggleWarningAcknowledgement(stateSel, 'root/p2', batch.packages);
      expect(stateUnAck.acknowledgedWarningPackagePaths).toEqual([]);
      expect(stateUnAck.selectedPackagePaths).toEqual(['root/p1']);
    });

    it('30. Invalid-package toggle returns unchanged state', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateValid = toggleValidPackage(initial, 'root/p3', batch.packages);
      const stateWarn = toggleWarningPackageSelection(initial, 'root/p3', batch.packages);
      const stateAck = toggleWarningAcknowledgement(initial, 'root/p3', batch.packages);

      expect(stateValid).toEqual(initial);
      expect(stateWarn).toEqual(initial);
      expect(stateAck).toEqual(initial);
    });

    it('31. Unknown-package toggle returns unchanged state', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);

      const stateValid = toggleValidPackage(initial, 'root/unknown', batch.packages);
      const stateWarn = toggleWarningPackageSelection(initial, 'root/unknown', batch.packages);
      const stateAck = toggleWarningAcknowledgement(initial, 'root/unknown', batch.packages);

      expect(stateValid).toEqual(initial);
      expect(stateWarn).toEqual(initial);
      expect(stateAck).toEqual(initial);
    });

    it('32. Selection changes invalidate prepared intent', () => {
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

    it('33. Acknowledgement changes invalidate prepared intent', () => {
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
      const ackedState = toggleWarningAcknowledgement(preparedState, 'root/p2', batch.packages);
      expect(ackedState.preparedIntent).toBeNull();
    });

    it('34. New preview or clear selection resets all state', () => {
      const batch = makeMockPreviewBatch();
      const initial = createInitialSelectionState(batch);
      const stateAck = toggleWarningAcknowledgement(initial, 'root/p2', batch.packages);
      const statePrep = setPreparing(stateAck, true);
      expect(statePrep.isPreparing).toBe(true);

      const resetState = resetSelectionState();
      expect(resetState.previewFingerprint).toBe('');
      expect(resetState.selectedPackagePaths).toEqual([]);
      expect(resetState.acknowledgedWarningPackagePaths).toEqual([]);
      expect(resetState.isPreparing).toBe(false);
      expect(resetState.preparedIntent).toBeNull();
      expect(resetState.preparationErrorCode).toBeNull();
    });

    it('35. Successful preparation stores exact intent, failure stores bounded error code', () => {
      const initial = resetSelectionState();
      const mockIntent = {
        version: 1 as const,
        previewFingerprint: 'a'.repeat(64),
        selectedRootName: 'root',
        fileCount: 5,
        declaredTotalBytes: 1000,
        selectedPackagePaths: ['root/p1'],
        acknowledgedWarningPackagePaths: [],
      };

      const stateSuccess = setPreparedSuccess(initial, mockIntent);
      expect(stateSuccess.preparedIntent).toEqual(mockIntent);
      expect(stateSuccess.preparationErrorCode).toBeNull();

      const stateFail = setPreparedFailure(initial, 'PREVIEW_FINGERPRINT_MISMATCH');
      expect(stateFail.preparedIntent).toBeNull();
      expect(stateFail.preparationErrorCode).toBe('PREVIEW_FINGERPRINT_MISMATCH');
    });
  });

  describe('Executable Preparation Controller Lifecycle Suite', () => {
    function createDeferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('37. First request acquires lock synchronously, second request while locked is ignored', async () => {
      const lock: BrowserImportPreparationLock = { current: false };
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();
      const initial = createInitialSelectionState(preview);

      let currentState = initial;
      const stateUpdates: BrowserImportSelectionState[] = [];
      const setSelectionState = (updater: (prev: BrowserImportSelectionState) => BrowserImportSelectionState) => {
        currentState = updater(currentState);
        stateUpdates.push(currentState);
      };

      const deferred = createDeferred<void>();
      let plannerCallCount = 0;

      const p1 = runBrowserImportPreparation({
        lock,
        currentState,
        previewResult: preview,
        manifestCache: manifest,
        getCurrentState: () => currentState,
        setSelectionState,
        yieldControl: () => deferred.promise,
        prepareOverride: (params) => {
          plannerCallCount++;
          return prepareBrowserImportCommitIntent(params);
        },
      });

      // Verify lock acquired synchronously
      expect(lock.current).toBe(true);
      expect(currentState.isPreparing).toBe(true);

      // Attempt second call while locked
      const p2 = runBrowserImportPreparation({
        lock,
        currentState,
        previewResult: preview,
        manifestCache: manifest,
        getCurrentState: () => currentState,
        setSelectionState,
        yieldControl: () => Promise.resolve(),
        prepareOverride: (params) => {
          plannerCallCount++;
          return prepareBrowserImportCommitIntent(params);
        },
      });

      await p2;

      // Resolve first call
      deferred.resolve();
      await p1;

      expect(plannerCallCount).toBe(1);
      expect(lock.current).toBe(false);
      expect(currentState.preparedIntent).not.toBeNull();
    });

    it('38. Pending state is entered before async boundary resolves', async () => {
      const lock: BrowserImportPreparationLock = { current: false };
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();
      const initial = createInitialSelectionState(preview);

      let currentState = initial;
      const setSelectionState = (updater: (prev: BrowserImportSelectionState) => BrowserImportSelectionState) => {
        currentState = updater(currentState);
      };

      const deferred = createDeferred<void>();
      let isPreparingBeforeYield = false;

      const p = runBrowserImportPreparation({
        lock,
        currentState,
        previewResult: preview,
        manifestCache: manifest,
        getCurrentState: () => currentState,
        setSelectionState,
        yieldControl: async () => {
          isPreparingBeforeYield = currentState.isPreparing;
          await deferred.promise;
        },
      });

      expect(isPreparingBeforeYield).toBe(true);
      deferred.resolve();
      await p;
    });

    it('39. Lock is released after success, failure, and unexpected exception', async () => {
      const lock: BrowserImportPreparationLock = { current: false };
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();

      let state = createInitialSelectionState(preview);
      const setSelectionState = (u: (prev: BrowserImportSelectionState) => BrowserImportSelectionState) => { state = u(state); };

      // Success case
      await runBrowserImportPreparation({
        lock,
        currentState: state,
        previewResult: preview,
        manifestCache: manifest,
        getCurrentState: () => state,
        setSelectionState,
        yieldControl: () => Promise.resolve(),
      });
      expect(lock.current).toBe(false);
      expect(state.preparedIntent).not.toBeNull();

      // Failure case (empty selection)
      state = { ...state, selectedPackagePaths: [] };
      await runBrowserImportPreparation({
        lock,
        currentState: state,
        previewResult: preview,
        manifestCache: manifest,
        getCurrentState: () => state,
        setSelectionState,
        yieldControl: () => Promise.resolve(),
      });
      expect(lock.current).toBe(false);
      expect(state.preparationErrorCode).toBe('EMPTY_SELECTION');

      // Unexpected exception case
      state = createInitialSelectionState(preview);
      await runBrowserImportPreparation({
        lock,
        currentState: state,
        previewResult: preview,
        manifestCache: manifest,
        getCurrentState: () => state,
        setSelectionState,
        yieldControl: () => Promise.resolve(),
        prepareOverride: () => { throw new Error('Uncaught low-level crash'); },
      });
      expect(lock.current).toBe(false);
      expect(state.preparationErrorCode).toBe('UNEXPECTED_PREPARATION_FAILURE');
    });

    it('40. Selection or warning acknowledgement changing during async boundary discards result', async () => {
      const lock: BrowserImportPreparationLock = { current: false };
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();
      const initial = createInitialSelectionState(preview);

      let state = initial;
      const setSelectionState = (u: (prev: BrowserImportSelectionState) => BrowserImportSelectionState) => { state = u(state); };

      const deferred = createDeferred<void>();

      const p = runBrowserImportPreparation({
        lock,
        currentState: state,
        previewResult: preview,
        manifestCache: manifest,
        getCurrentState: () => state,
        setSelectionState,
        yieldControl: () => deferred.promise,
      });

      // Mutate selection state during yield boundary
      state = toggleValidPackage(state, 'root/p1', preview.packages);

      deferred.resolve();
      await p;

      expect(state.preparedIntent).toBeNull();
      expect(state.preparationErrorCode).toBe('PREVIEW_FINGERPRINT_MISMATCH');
    });
    it('41. Atomic state-updater snapshot guard rejects intent when external getCurrentState is stale', async () => {
      const lock: BrowserImportPreparationLock = { current: false };
      const preview = makeMockPreviewBatch();
      const manifest = makeMockManifest();
      const stateA = createInitialSelectionState(preview);

      // Folder selection or reset produces stateB with different fingerprint/paths
      const stateB = resetSelectionState();

      let actualState = stateA;
      const setSelectionState = (u: (prev: BrowserImportSelectionState) => BrowserImportSelectionState) => {
        actualState = u(actualState);
      };

      const deferred = createDeferred<void>();

      const p = runBrowserImportPreparation({
        lock,
        currentState: stateA,
        previewResult: preview,
        manifestCache: manifest,
        // Simulate broken/delayed external observer returning stale stateA
        getCurrentState: () => stateA,
        setSelectionState,
        yieldControl: () => deferred.promise,
      });

      // External state change occurs during async yield boundary
      actualState = stateB;

      deferred.resolve();
      await p;

      // Assert old intent is not stored, stateB is not replaced by stateA, result rejected as stale
      expect(actualState.preparedIntent).toBeNull();
      expect(actualState.preparationErrorCode).toBe('PREVIEW_FINGERPRINT_MISMATCH');
      expect(lock.current).toBe(false);
    });
  });

  describe('Component Accessible Labels & Static Contract', () => {
    it('42. Component source contains package-specific aria-labels, visible status badges, and guarded controls', () => {
      const filePath = join(__dirname, '../../components/imports/BrowserImportPreviewClient.tsx');
      const source = readFileSync(filePath, 'utf8');

      expect(source).toContain('aria-label={`Select package ${pkg.folderName} for import`}');
      expect(source).toContain('aria-label={`Acknowledge warnings for package ${pkg.folderName}`}');
      expect(source).toContain('aria-label={`Select warning package ${pkg.folderName} for import after acknowledgement`}');
      expect(source).toContain('aria-label={`Package ${pkg.folderName} is invalid and cannot be selected`}');
      expect(source).toContain('{pkg.status.toUpperCase()}');
      expect(source).toContain('disabled={isLoading || !isSupported || isPreparingOrLocked}');
      expect(source).toContain('disabled={isLoading || isPreparingOrLocked}');
      expect(source).toContain('if (preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging) return;');
      expect(source).toContain('updateSelectionState(');
    });
  });
});
