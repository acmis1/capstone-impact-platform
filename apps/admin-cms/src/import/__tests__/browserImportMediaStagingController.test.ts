import { describe, it, expect, vi } from 'vitest';
import { runBrowserImportMediaStaging } from '../browserImportMediaStagingController';
import { BrowserImportCommitIntent } from '../browserImportCommitIntentContract';
import { SelectionManifest } from '../browserImportPreviewContract';
import { generateUploadKey } from '../browserSelection';

describe('Browser Import Media Staging Controller Unit Tests', () => {
  const dummyIntent: BrowserImportCommitIntent = {
    version: 1,
    previewFingerprint: 'a'.repeat(64),
    selectedRootName: 'root',
    fileCount: 3,
    declaredTotalBytes: 900,
    selectedPackagePaths: ['root/pkg-a'],
    acknowledgedWarningPackagePaths: [],
  };

  const dummyManifest: SelectionManifest = {
    selectedRootName: 'root',
    fileCount: 4,
    declaredTotalBytes: 1300,
    ignoredSystemFilesCount: 0,
    descriptors: [
      { uploadKey: generateUploadKey('root/pkg-a/project.json'), originalPath: 'root/pkg-a/project.json', fileSizeBytes: 100, browserMimeType: 'application/json' },
      { uploadKey: generateUploadKey('root/pkg-a/poster.png'), originalPath: 'root/pkg-a/poster.png', fileSizeBytes: 400, browserMimeType: 'image/png' },
      { uploadKey: generateUploadKey('root/pkg-b/project.json'), originalPath: 'root/pkg-b/project.json', fileSizeBytes: 100, browserMimeType: 'application/json' },
      { uploadKey: generateUploadKey('root/pkg-b/poster.png'), originalPath: 'root/pkg-b/poster.png', fileSizeBytes: 400, browserMimeType: 'image/png' },
    ],
  };

  const makeFile = (name: string, relativePath: string, body: string, type: string) => {
    const file = new File([body], name, { type });
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
    return file;
  };

  const metaFileA = makeFile('project.json', 'root/pkg-a/project.json', '{"publicId":"pkg-a"}', 'application/json');
  const posterFileA = makeFile('poster.png', 'root/pkg-a/poster.png', 'image bytes a', 'image/png');
  const posterPdfFileA = makeFile('poster.pdf', 'root/pkg-a/poster.pdf', 'pdf bytes', 'application/pdf');
  const snapshot1FileA = makeFile('snapshot-1.png', 'root/pkg-a/snapshot-1.png', 'snapshot bytes 1', 'image/png');
  const snapshot2FileA = makeFile('snapshot-2.jpg', 'root/pkg-a/snapshot-2.jpg', 'snapshot bytes 2', 'image/jpeg');
  const snapshot3WebpFileA = makeFile('snapshot-3.webp', 'root/pkg-a/snapshot-3.webp', 'snapshot bytes 3', 'image/webp');
  const snapshotUnsupportedFileA = makeFile('snapshot-3.gif', 'root/pkg-a/snapshot-3.gif', 'snapshot bytes 3', 'image/gif');
  const unselectedSnapshotB = makeFile('snapshot-1.png', 'root/pkg-b/snapshot-1.png', 'other snapshot bytes', 'image/png');

  const metaFileB = makeFile('project.json', 'root/pkg-b/project.json', '{"publicId":"pkg-b"}', 'application/json');
  const posterFileB = makeFile('poster.png', 'root/pkg-b/poster.png', 'image bytes b', 'image/png');

  const allFiles = [
    metaFileA,
    posterFileA,
    posterPdfFileA,
    snapshot1FileA,
    snapshot2FileA,
    snapshot3WebpFileA,
    snapshotUnsupportedFileA,
    metaFileB,
    posterFileB,
    unselectedSnapshotB,
  ];

  it('1. Enforces synchronous duplicate submission lock and rejects same-tick calls', async () => {
    const lock = { current: false };
    const setIsCompletingMedia = vi.fn();
    const setMediaCompleteError = vi.fn();
    const setMediaCompleteResult = vi.fn();

    const mockResponseBody = {
      success: true,
      result: 'completed' as const,
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 1,
      batchStatus: 'completed' as const,
    };

    let resolveFetch!: (res: unknown) => void;
    const fetchFn = vi.fn().mockImplementation(() => new Promise((res) => { resolveFetch = res; }));

    const call1Promise = runBrowserImportMediaStaging({
      lock,
      isCompletingMedia: false,
      batchId: '11111111-1111-1111-1111-111111111111',
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedPackagePaths: ['root/pkg-a'],
      selectedFiles: allFiles,
      setIsCompletingMedia,
      setMediaCompleteError,
      setMediaCompleteResult,
      fetchFn,
    });

    expect(lock.current).toBe(true);

    const res2 = await runBrowserImportMediaStaging({
      lock,
      isCompletingMedia: false,
      batchId: '11111111-1111-1111-1111-111111111111',
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedPackagePaths: ['root/pkg-a'],
      selectedFiles: allFiles,
      setIsCompletingMedia,
      setMediaCompleteError,
      setMediaCompleteResult,
      fetchFn,
    });

    expect(res2).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: () => Promise.resolve(mockResponseBody) });

    const res1 = await call1Promise;
    expect(res1?.success).toBe(true);
    expect(lock.current).toBe(false);
    expect(setMediaCompleteResult).toHaveBeenCalledWith({
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 1,
      result: 'completed',
    });
  });

  it('2. Attaches metadata files for all packages but only media files for selected packages', async () => {
    const lock = { current: false };
    const setIsCompletingMedia = vi.fn();
    const setMediaCompleteError = vi.fn();
    const setMediaCompleteResult = vi.fn();

    let capturedFormData: FormData | null = null;
    const fetchFn = vi.fn().mockImplementation((_url, opts) => {
      capturedFormData = opts.body as FormData;
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        result: 'completed',
        batchId: '11111111-1111-1111-1111-111111111111',
        mediaAssetCount: 1,
        batchStatus: 'completed',
      }), { status: 200 }));
    });

    await runBrowserImportMediaStaging({
      lock,
      isCompletingMedia: false,
      batchId: '11111111-1111-1111-1111-111111111111',
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedPackagePaths: ['root/pkg-a'],
      selectedFiles: allFiles,
      setIsCompletingMedia,
      setMediaCompleteError,
      setMediaCompleteResult,
      fetchFn,
    });

    expect(capturedFormData).not.toBeNull();
    const fd = capturedFormData!;
    expect(fd.get('batchId')).toBe('11111111-1111-1111-1111-111111111111');
    expect(fd.has('manifest')).toBe(true);
    expect(fd.has('intent')).toBe(true);

    const keys = Array.from(fd.keys());
    // Metadata files for both packages are resent (server needs them to re-derive full state)
    expect(keys).toContain(generateUploadKey('root/pkg-a/project.json'));
    expect(keys).toContain(generateUploadKey('root/pkg-b/project.json'));
    // Media file for the selected package is attached
    expect(keys).toContain(generateUploadKey('root/pkg-a/poster.png'));
    expect(keys).toContain(generateUploadKey('root/pkg-a/poster.pdf'));
    expect(keys).toContain(generateUploadKey('root/pkg-a/snapshot-1.png'));
    expect(keys).toContain(generateUploadKey('root/pkg-a/snapshot-2.jpg'));
    expect(keys).toContain(generateUploadKey('root/pkg-a/snapshot-3.webp'));
    expect(keys).not.toContain(generateUploadKey('root/pkg-a/snapshot-3.gif'));
    // Media file for the unselected package is NOT attached
    expect(keys).not.toContain(generateUploadKey('root/pkg-b/poster.png'));
    expect(keys).not.toContain(generateUploadKey('root/pkg-b/snapshot-1.png'));
  });

  it('2b. Attaches referenceFile and adminReferenceMapping when provided', async () => {
    const lock = { current: false };
    const setIsCompletingMedia = vi.fn();
    const setMediaCompleteError = vi.fn();
    const setMediaCompleteResult = vi.fn();

    let capturedFormData: FormData | null = null;
    const fetchFn = vi.fn().mockImplementation((_url, opts) => {
      capturedFormData = opts.body as FormData;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            result: 'completed',
            batchId: '11111111-1111-1111-1111-111111111111',
            mediaAssetCount: 1,
            batchStatus: 'completed',
          }),
          { status: 200 }
        )
      );
    });

    const refFile = new File(['fake xlsx bytes'], 'ref.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const refMapping = {
      worksheet: 'REFERENCE',
      matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
      comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Official Project Title' }],
      reconciliationContractVersion: 'admin-reference-reconciliation-v1' as const,
    };

    await runBrowserImportMediaStaging({
      lock,
      isCompletingMedia: false,
      batchId: '11111111-1111-1111-1111-111111111111',
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedPackagePaths: ['root/pkg-a'],
      selectedFiles: allFiles,
      adminReferenceFile: refFile,
      adminReferenceMappingConfig: refMapping,
      setIsCompletingMedia,
      setMediaCompleteError,
      setMediaCompleteResult,
      fetchFn,
    });

    expect(capturedFormData).not.toBeNull();
    const fd = capturedFormData!;
    expect(fd.get('referenceFile')).toBe(refFile);
    expect(fd.get('adminReferenceMapping')).toBe(JSON.stringify(refMapping));
  });

  it('3. Does not call fetch when batchId is missing (metadata not yet staged)', async () => {
    const lock = { current: false };
    const fetchFn = vi.fn();

    const res = await runBrowserImportMediaStaging({
      lock,
      isCompletingMedia: false,
      batchId: null,
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedPackagePaths: ['root/pkg-a'],
      selectedFiles: allFiles,
      setIsCompletingMedia: vi.fn(),
      setMediaCompleteError: vi.fn(),
      setMediaCompleteResult: vi.fn(),
      fetchFn,
    });

    expect(res).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('4. Fails closed on malformed HTTP 200 response and releases lock, preserving retry path', async () => {
    const lock = { current: false };
    const setIsCompletingMedia = vi.fn();
    const setMediaCompleteError = vi.fn();
    const setMediaCompleteResult = vi.fn();

    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: 'completed',
      batchId: 'not-a-uuid',
      mediaAssetCount: 1,
      batchStatus: 'completed',
    }), { status: 200 }));

    const res = await runBrowserImportMediaStaging({
      lock,
      isCompletingMedia: false,
      batchId: '11111111-1111-1111-1111-111111111111',
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedPackagePaths: ['root/pkg-a'],
      selectedFiles: allFiles,
      setIsCompletingMedia,
      setMediaCompleteError,
      setMediaCompleteResult,
      fetchFn,
    });

    expect(res?.success).toBe(false);
    expect(lock.current).toBe(false);
    expect(setMediaCompleteError).toHaveBeenCalled();
    expect(setMediaCompleteResult).not.toHaveBeenCalled();
  });

  it('5. Maps a known server error code to its user-facing retry-safe message', async () => {
    const lock = { current: false };
    const setMediaCompleteError = vi.fn();

    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      code: 'STORAGE_CONFLICT',
      error: 'A media storage conflict was detected. Please try again.',
    }), { status: 409 }));

    const res = await runBrowserImportMediaStaging({
      lock,
      isCompletingMedia: false,
      batchId: '11111111-1111-1111-1111-111111111111',
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedPackagePaths: ['root/pkg-a'],
      selectedFiles: allFiles,
      setIsCompletingMedia: vi.fn(),
      setMediaCompleteError,
      setMediaCompleteResult: vi.fn(),
      fetchFn,
    });

    expect(res?.success).toBe(false);
    expect(lock.current).toBe(false);
    expect(setMediaCompleteError).toHaveBeenCalledWith('A media storage conflict was detected. Please try again.');
  });
});
