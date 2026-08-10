import { describe, it, expect, vi } from 'vitest';
import { runBrowserImportMetadataStaging } from '../browserImportStagingController';
import { BrowserImportCommitIntent } from '../browserImportCommitIntentContract';
import { SelectionManifest } from '../browserImportPreviewContract';
import { generateUploadKey } from '../browserSelection';

describe('Browser Import Staging Controller Unit Tests', () => {
  const dummyIntent: BrowserImportCommitIntent = {
    version: 1,
    previewFingerprint: 'a'.repeat(64),
    selectedRootName: 'pkg1',
    fileCount: 2,
    declaredTotalBytes: 500,
    selectedPackagePaths: ['pkg1'],
    acknowledgedWarningPackagePaths: [],
  };

  const dummyManifest: SelectionManifest = {
    selectedRootName: 'pkg1',
    fileCount: 2,
    declaredTotalBytes: 500,
    ignoredSystemFilesCount: 0,
    descriptors: [
      { uploadKey: generateUploadKey('pkg1/project.json'), originalPath: 'pkg1/project.json', fileSizeBytes: 100, browserMimeType: 'application/json' },
      { uploadKey: generateUploadKey('pkg1/poster.png'), originalPath: 'pkg1/poster.png', fileSizeBytes: 400, browserMimeType: 'image/png' },
    ],
  };

  const metaFile = new File(['{"publicId":"pkg1"}'], 'project.json', { type: 'application/json' });
  Object.defineProperty(metaFile, 'webkitRelativePath', { value: 'pkg1/project.json' });

  const posterFile = new File(['image bytes'], 'poster.png', { type: 'image/png' });
  Object.defineProperty(posterFile, 'webkitRelativePath', { value: 'pkg1/poster.png' });

  it('1. Enforces synchronous duplicate submission lock and rejects same-tick calls', async () => {
    const lock = { current: false };
    const setIsStaging = vi.fn();
    const setStagingError = vi.fn();
    const setStagedResult = vi.fn();

    const mockResponseBody = {
      success: true,
      result: 'created' as const,
      batchId: '11111111-1111-1111-1111-111111111111',
      projectCount: 1,
      warningCount: 0,
      batchStatus: 'metadata_staged' as const,
    };

    let resolveFetch!: (res: unknown) => void;
    const fetchFn = vi.fn().mockImplementation(() => new Promise((res) => { resolveFetch = res; }));

    const call1Promise = runBrowserImportMetadataStaging({
      lock,
      isStaging: false,
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedFiles: [metaFile, posterFile],
      setIsStaging,
      setStagingError,
      setStagedResult,
      fetchFn,
    });

    expect(lock.current).toBe(true);

    // Second call in same tick while call 1 is pending
    const res2 = await runBrowserImportMetadataStaging({
      lock,
      isStaging: false,
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedFiles: [metaFile, posterFile],
      setIsStaging,
      setStagingError,
      setStagedResult,
      fetchFn,
    });

    expect(res2).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const mockResponse = {
      ok: true,
      json: () => Promise.resolve(mockResponseBody),
    };
    resolveFetch(mockResponse);

    const res1 = await call1Promise;
    expect(res1?.success).toBe(true);
    expect(lock.current).toBe(false);
    expect(setStagedResult).toHaveBeenCalledWith({
      batchId: '11111111-1111-1111-1111-111111111111',
      projectCount: 1,
      warningCount: 0,
      result: 'created',
    });
  });

  it('2. Filters selected files so only project-details.xlsx/project.json are attached in FormData', async () => {
    const lock = { current: false };
    const setIsStaging = vi.fn();
    const setStagingError = vi.fn();
    const setStagedResult = vi.fn();

    let capturedFormData: FormData | null = null;
    const fetchFn = vi.fn().mockImplementation((_url, opts) => {
      capturedFormData = opts.body as FormData;
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        result: 'created',
        batchId: '11111111-1111-1111-1111-111111111111',
        projectCount: 1,
        warningCount: 0,
        batchStatus: 'metadata_staged',
      }), { status: 200 }));
    });

    await runBrowserImportMetadataStaging({
      lock,
      isStaging: false,
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedFiles: [metaFile, posterFile],
      setIsStaging,
      setStagingError,
      setStagedResult,
      fetchFn,
    });

    expect(capturedFormData).not.toBeNull();
    const fd = capturedFormData!;
    expect(fd.has('manifest')).toBe(true);
    expect(fd.has('intent')).toBe(true);

    const keys = Array.from(fd.keys());
    expect(keys).toContain(generateUploadKey('pkg1/project.json'));
    expect(keys).not.toContain(generateUploadKey('pkg1/poster.png'));
  });

  it('3. Fails closed on malformed HTTP 200 or unknown error code and releases lock', async () => {
    const lock = { current: false };
    const setIsStaging = vi.fn();
    const setStagingError = vi.fn();
    const setStagedResult = vi.fn();

    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: 'created',
      batchId: 'invalid-uuid-string',
      projectCount: 1,
      warningCount: 0,
      batchStatus: 'metadata_staged',
    }), { status: 200 }));

    const res = await runBrowserImportMetadataStaging({
      lock,
      isStaging: false,
      preparedIntent: dummyIntent,
      manifestCache: dummyManifest,
      selectedFiles: [metaFile],
      setIsStaging,
      setStagingError,
      setStagedResult,
      fetchFn,
    });

    expect(res?.success).toBe(false);
    expect(lock.current).toBe(false);
    expect(setStagingError).toHaveBeenCalledWith('The metadata staging operation could not be completed. Please try again.');
    expect(setStagedResult).not.toHaveBeenCalled();
  });
});
