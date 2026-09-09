// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  canResumeAnnualIntake,
  createBrowserAnnualIntakeProgressStore,
  createInitialAnnualIntakeProgress,
  ANNUAL_INTAKE_MAX_RAW_MEDIA_BYTES,
  partitionAnnualIntakeFiles,
  type AnnualIntakeLockRunner,
  type AnnualIntakePreviewPlan,
  type AnnualIntakeProgress,
  type AnnualIntakeProgressStore,
  withAnnualIntakeInFlightLock,
} from '../annualIntakeContract';
import { runAnnualIntakeImport, runAnnualIntakePreview } from '../annualIntakeOrchestration';
import type { AdminReferenceIntent, AdminReferenceMappingConfig } from '../adminReferenceSharedContract';

const ROOT = 'annual-2026';
const REFERENCE_INTENT: AdminReferenceIntent = {
  workbookFingerprint: 'f'.repeat(64),
  worksheet: 'REFERENCE',
  matchMappings: [{ canonicalField: 'publicId', referenceColumn: 'Public ID' }],
  comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Title' }],
  reconciliationContractVersion: 'admin-reference-reconciliation-v1',
};

function makeFile(relativePath: string, body: string, type: string): File {
  const name = relativePath.split('/').pop()!;
  const file = new File([body], name, { type });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

function makeSizedFile(relativePath: string, size: number, type = 'image/png'): File {
  const file = makeFile(relativePath, 'x', type);
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

function make120PackageFiles(): File[] {
  return Array.from({ length: 120 }, (_, index) => {
    const packageName = `project-${String(index + 1).padStart(3, '0')}`;
    return [
      makeFile(`${ROOT}/${packageName}/project.json`, `{"title":"${packageName}"}`, 'application/json'),
      makeFile(`${ROOT}/${packageName}/poster.png`, 'poster bytes', 'image/png'),
    ];
  }).flat();
}

function previewBody(chunkIndex: number, manifest: { selectedRootName: string; fileCount: number; declaredTotalBytes: number; descriptors: Array<{ originalPath: string }> }): Record<string, unknown> {
  const packagePaths = Array.from(new Set(
    manifest.descriptors.map((descriptor) => descriptor.originalPath.split('/').slice(0, 2).join('/')),
  )).sort();
  const packages = packagePaths.map((packagePath) => ({
    packagePath,
    folderName: packagePath.split('/')[1],
    proposedPublicId: packagePath.split('/')[1],
    metadataSource: 'json',
    status: 'valid',
    previewMetadata: {
      title: packagePath.split('/')[1],
      year: '2026',
      program: 'Program',
      discipline: 'Discipline',
      groupName: packagePath.split('/')[1],
      teamMemberCount: 1,
      layoutTemplate: 'poster_showcase',
      featuredMedia: 'poster',
    },
    filePresence: { xlsxPresent: false, jsonPresent: true, posterImagePresent: true, posterPdfPresent: false, snapshotPresent: false },
    reconciliation: { status: 'RECONCILED', matchedRowNumber: 1, mismatchedFields: [] },
    errors: [],
    warnings: [],
  }));
  return {
    success: true,
    batch: {
      previewFingerprint: `${String(chunkIndex + 1).padStart(2, '0')}${'a'.repeat(62)}`,
      mode: 'batch',
      selectedRootName: manifest.selectedRootName,
      packageCount: packages.length,
      selectedFileCount: manifest.fileCount,
      declaredTotalBytes: manifest.declaredTotalBytes,
      validPackageCount: packages.length,
      warningPackageCount: 0,
      invalidPackageCount: 0,
      totalWarnings: 0,
      totalErrors: 0,
      mediaValidationMode: 'descriptor_only',
      batchIssues: [],
      packages,
      adminReference: REFERENCE_INTENT,
    },
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function memoryStore(): AnnualIntakeProgressStore & { value: AnnualIntakeProgress | null } {
  const store: AnnualIntakeProgressStore & { value: AnnualIntakeProgress | null } = {
    value: null,
    read: () => store.value,
    write: (progress) => { store.value = progress; },
  };
  return store;
}

function stageResponse(
  result: 'created' | 'already_staged',
  batchId: string,
  batchStatus: 'metadata_staged' | 'completed' = 'metadata_staged',
): Response {
  return makeResponse({ success: true, result, batchId, projectCount: 25, warningCount: 0, batchStatus });
}

function mediaResponse(result: 'completed' | 'already_completed', batchId: string): Response {
  return makeResponse({ success: true, result, batchId, mediaAssetCount: 25, batchStatus: 'completed' });
}

const unlocked: AnnualIntakeLockRunner = async (_cohortId, task) => ({ acquired: true, value: await task() });

function installNavigatorLocks(value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value });
  return () => {
    if (original) {
      Object.defineProperty(navigator, 'locks', original);
    } else {
      Reflect.deleteProperty(navigator, 'locks');
    }
  };
}

async function previewFiles(files: File[], fingerprintIndex = 0) {
  const fetchFn: typeof fetch = async (_input, init) => {
    const manifest = JSON.parse(String((init?.body as FormData).get('manifest')));
    return makeResponse(previewBody(fingerprintIndex, manifest));
  };
  return runAnnualIntakePreview({ selectedFiles: files, selectedRootName: ROOT, fetchFn });
}

describe('Annual intake browser orchestration', () => {
  it('previews exactly 120 packages in deterministic <=25-package requests', async () => {
    const files = make120PackageFiles();
    const expectedChunks = partitionAnnualIntakeFiles(files, ROOT);
    expect(expectedChunks.map((chunk) => chunk.packagePaths.length)).toEqual([25, 25, 25, 25, 20]);

    const requestManifests: string[][] = [];
    let previewRequestIndex = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      const manifest = JSON.parse(String((init?.body as FormData).get('manifest')));
      requestManifests.push(Array.from(new Set((manifest.descriptors as Array<{ originalPath: string }>)
        .map((descriptor) => descriptor.originalPath.split('/').slice(0, 2).join('/')))).sort());
      const response = makeResponse(previewBody(previewRequestIndex % 5, manifest));
      previewRequestIndex += 1;
      return response;
    };

    const result = await runAnnualIntakePreview({ selectedFiles: files, selectedRootName: ROOT, fetchFn });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.plan.cohortId).toMatch(/^annual-[a-f0-9]{64}$/);
    expect(result.plan.mergedPreview.packageCount).toBe(120);
    expect(result.plan.chunks.map((chunk) => chunk.packagePaths.length)).toEqual([25, 25, 25, 25, 20]);
    expect(requestManifests).toHaveLength(5);
    expect(requestManifests.every((paths) => paths.length <= 25)).toBe(true);
  });

  it('splits individually valid media-heavy packages below the later media request ceiling', () => {
    const makeMediaHeavyPackage = (packageName: string) => [
      makeSizedFile(`${ROOT}/${packageName}/project.json`, 100, 'application/json'),
      makeSizedFile(`${ROOT}/${packageName}/poster.png`, 5 * 1024 * 1024),
      makeSizedFile(`${ROOT}/${packageName}/poster.pdf`, 20 * 1024 * 1024, 'application/pdf'),
      ...Array.from({ length: 10 }, (_, index) => makeSizedFile(
        `${ROOT}/${packageName}/snapshot-${index + 1}.png`,
        5 * 1024 * 1024,
      )),
    ];
    const files = [
      ...makeMediaHeavyPackage('project-001'),
      ...makeMediaHeavyPackage('project-002'),
    ];

    const chunks = partitionAnnualIntakeFiles(files, ROOT);

    expect(ANNUAL_INTAKE_MAX_RAW_MEDIA_BYTES).toBe(110 * 1024 * 1024);
    expect(chunks.map((chunk) => chunk.packagePaths)).toEqual([
      [`${ROOT}/project-001`],
      [`${ROOT}/project-002`],
    ]);
  });

  it('rejects a single media-heavy package before preview requests or metadata persistence', async () => {
    const files = [
      makeSizedFile(`${ROOT}/project-001/project.json`, 100, 'application/json'),
      makeSizedFile(`${ROOT}/project-001/poster.png`, ANNUAL_INTAKE_MAX_RAW_MEDIA_BYTES + 1),
    ];
    const fetchFn = vi.fn<typeof fetch>();

    const result = await runAnnualIntakePreview({ selectedFiles: files, selectedRootName: ROOT, fetchFn });

    expect(result).toEqual({
      success: false,
      code: 'MEDIA_REQUEST_LIMIT_EXCEEDED',
      error: expect.stringMatching(/single project package exceeds.*media request limit/i),
      failedChunkIndex: 0,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('resumes an interrupted media chunk with authoritative metadata replay', async () => {
    const files = make120PackageFiles();
    const previewResult = await previewFiles(files);
    expect(previewResult.success).toBe(true);
    if (!previewResult.success) return;

    const plan: AnnualIntakePreviewPlan = previewResult.plan;
    const selectedPackagePaths = plan.mergedPreview.packages.map((pkg) => pkg.packagePath);
    const store = memoryStore();
    const firstRunCalls: string[] = [];
    const firstRunFetch: typeof fetch = async (input) => {
      const url = String(input);
      firstRunCalls.push(url);
      if (url.endsWith('/stage-metadata')) {
        const index = firstRunCalls.filter((calledUrl) => calledUrl.endsWith('/stage-metadata')).length;
        return stageResponse('created', `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
      }
      const mediaIndex = firstRunCalls.filter((calledUrl) => calledUrl.endsWith('/stage-media')).length;
      if (mediaIndex === 3) return makeResponse({ success: false, code: 'STORAGE_UPLOAD_FAILED', error: 'temporary failure' }, 500);
      return mediaResponse('completed', `00000000-0000-4000-8000-${String(mediaIndex).padStart(12, '0')}`);
    };

    const interrupted = await runAnnualIntakeImport({
      plan,
      selectedPackagePaths,
      acknowledgedWarningPackagePaths: [],
      progressStore: store,
      fetchFn: firstRunFetch,
      lockRunner: unlocked,
    });
    expect(interrupted.success).toBe(false);
    expect(interrupted.failedChunkIndex).toBe(2);
    expect(interrupted.progress).toEqual(store.value);
    expect(interrupted.progress.lastError).toBe('temporary failure');
    expect(interrupted.progress.failedChunkIndex).toBe(2);
    expect(store.value?.chunks.slice(0, 2).every((chunk) => chunk.status === 'completed')).toBe(true);
    expect(store.value?.chunks[2]).toMatchObject({ status: 'failed', failurePhase: 'media' });
    expect(store.value?.chunks[2].batchId).toBeTruthy();

    const persistedBeforeRetry = store.value!;
    const completedBatchIds = persistedBeforeRetry.chunks.map((chunk) => chunk.batchId);
    const retryBatchIds = completedBatchIds.map((batchId, index) =>
      batchId || `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    let metadataReplayIndex = 0;
    let mediaReplayIndex = 0;
    const retryCalls: string[] = [];
    const retryFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      retryCalls.push(url);
      if (url.endsWith('/stage-metadata')) {
        const index = metadataReplayIndex++;
        return stageResponse(
          completedBatchIds[index] ? 'already_staged' : 'created',
          retryBatchIds[index]!,
          completedBatchIds[index] ? 'completed' : 'metadata_staged',
        );
      }
      const batchId = String((init?.body as FormData).get('batchId'));
      const index = mediaReplayIndex++;
      return mediaResponse(index < 3 ? 'already_completed' : 'completed', batchId);
    };

    const resumed = await runAnnualIntakeImport({
      plan,
      selectedPackagePaths,
      acknowledgedWarningPackagePaths: [],
      existingProgress: store.value,
      progressStore: store,
      fetchFn: retryFetch,
      lockRunner: unlocked,
    });
    expect(resumed.success).toBe(true);
    expect(resumed.progress.chunks.every((chunk) => chunk.status === 'completed')).toBe(true);
    expect(retryCalls.filter((url) => url.endsWith('/stage-metadata'))).toHaveLength(5);
    expect(retryCalls.filter((url) => url.endsWith('/stage-media'))).toHaveLength(5);
    expect(resumed.progress.chunks.map((chunk) => chunk.batchId)).toEqual(retryBatchIds);
  });

  it('replays completed persisted progress instead of trusting stale caller state', async () => {
    const result = await previewFiles([makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const selected = [`${ROOT}/project-001`];
    const store = memoryStore();
    const firstRun = await runAnnualIntakeImport({
      plan: result.plan,
      selectedPackagePaths: selected,
      acknowledgedWarningPackagePaths: [],
      progressStore: store,
      fetchFn: async (input) => String(input).endsWith('/stage-metadata')
        ? stageResponse('created', '00000000-0000-4000-8000-000000000001')
        : mediaResponse('completed', '00000000-0000-4000-8000-000000000001'),
      lockRunner: unlocked,
    });
    expect(firstRun.success).toBe(true);
    expect(store.value?.chunks.every((chunk) => chunk.status === 'completed')).toBe(true);

    const storedSnapshot = JSON.stringify(store.value);
    const staleCallerState = createInitialAnnualIntakeProgress(result.plan, selected, []);
    const replayBatchId = store.value!.chunks[0].batchId!;
    const stageRequests: string[] = [];
    const secondRun = await runAnnualIntakeImport({
      plan: result.plan,
      selectedPackagePaths: selected,
      acknowledgedWarningPackagePaths: [],
      existingProgress: staleCallerState,
      progressStore: store,
      fetchFn: async (input, init) => {
        const url = String(input);
        stageRequests.push(url);
        if (url.endsWith('/stage-metadata')) {
          expect((init?.body as FormData).get('cohortId')).toBeNull();
          return stageResponse('already_staged', replayBatchId, 'completed');
        }
        expect(String((init?.body as FormData).get('batchId'))).toBe(replayBatchId);
        return mediaResponse('already_completed', replayBatchId);
      },
      lockRunner: unlocked,
    });

    expect(secondRun.success).toBe(true);
    expect(stageRequests).toEqual(['/api/imports/stage-metadata', '/api/imports/stage-media']);
    expect(JSON.stringify(store.value)).toBe(storedSnapshot);
  });

  it('does not trust a forged completed batch ID and converges through authoritative replay', async () => {
    const result = await previewFiles([makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const selected = [`${ROOT}/project-001`];
    const store = memoryStore();
    const forged = createInitialAnnualIntakeProgress(result.plan, selected, []);
    const fakeBatchId = '00000000-0000-4000-8000-00000000f001';
    const realBatchId = '00000000-0000-4000-8000-00000000a001';
    forged.chunks[0] = {
      ...forged.chunks[0],
      status: 'completed',
      batchId: fakeBatchId,
      mediaAssetCount: 1,
    };
    store.value = forged;

    const stageCalls: string[] = [];
    const submittedMediaBatchIds: string[] = [];
    const replay = await runAnnualIntakeImport({
      plan: result.plan,
      selectedPackagePaths: selected,
      acknowledgedWarningPackagePaths: [],
      existingProgress: createInitialAnnualIntakeProgress(result.plan, selected, []),
      progressStore: store,
      fetchFn: async (input, init) => {
        const url = String(input);
        stageCalls.push(url);
        if (url.endsWith('/stage-metadata')) return stageResponse('already_staged', realBatchId, 'completed');
        const batchId = String((init?.body as FormData).get('batchId'));
        submittedMediaBatchIds.push(batchId);
        return mediaResponse('already_completed', realBatchId);
      },
      lockRunner: unlocked,
    });

    expect(replay.success).toBe(true);
    expect(stageCalls).toEqual(['/api/imports/stage-metadata', '/api/imports/stage-media']);
    expect(submittedMediaBatchIds).toEqual([realBatchId]);
    expect(replay.progress.chunks[0].batchId).toBe(realBatchId);
    expect(replay.progress.chunks[0].batchId).not.toBe(fakeBatchId);
  });

  it('does not trust a forged failed-media batch ID and replays metadata before media', async () => {
    const result = await previewFiles([makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const selected = [`${ROOT}/project-001`];
    const store = memoryStore();
    const forged = createInitialAnnualIntakeProgress(result.plan, selected, []);
    const fakeBatchId = '00000000-0000-4000-8000-00000000f002';
    const realBatchId = '00000000-0000-4000-8000-00000000a002';
    forged.chunks[0] = {
      ...forged.chunks[0],
      status: 'failed',
      batchId: fakeBatchId,
      mediaAssetCount: 0,
      error: 'temporary failure',
      failurePhase: 'media',
    };
    store.value = forged;

    const stageCalls: string[] = [];
    const submittedMediaBatchIds: string[] = [];
    const replay = await runAnnualIntakeImport({
      plan: result.plan,
      selectedPackagePaths: selected,
      acknowledgedWarningPackagePaths: [],
      progressStore: store,
      fetchFn: async (input, init) => {
        const url = String(input);
        stageCalls.push(url);
        if (url.endsWith('/stage-metadata')) return stageResponse('already_staged', realBatchId, 'completed');
        const batchId = String((init?.body as FormData).get('batchId'));
        submittedMediaBatchIds.push(batchId);
        return mediaResponse('already_completed', realBatchId);
      },
      lockRunner: unlocked,
    });

    expect(replay.success).toBe(true);
    expect(stageCalls).toEqual(['/api/imports/stage-metadata', '/api/imports/stage-media']);
    expect(submittedMediaBatchIds).toEqual([realBatchId]);
    expect(replay.progress.chunks[0].batchId).toBe(realBatchId);
    expect(replay.progress.chunks[0].batchId).not.toBe(fakeBatchId);
  });

  it('rejects a created metadata response that claims the batch is already completed', async () => {
    const result = await previewFiles([makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stageCalls: string[] = [];
    const importResult = await runAnnualIntakeImport({
      plan: result.plan,
      selectedPackagePaths: [`${ROOT}/project-001`],
      acknowledgedWarningPackagePaths: [],
      fetchFn: async (input) => {
        stageCalls.push(String(input));
        return stageResponse('created', '00000000-0000-4000-8000-00000000c003', 'completed');
      },
      lockRunner: unlocked,
    });

    expect(importResult.success).toBe(false);
    expect(importResult.failedChunkIndex).toBe(0);
    expect(stageCalls).toEqual(['/api/imports/stage-metadata']);
  });

  it('rejects same-name/same-size replacements and changed server preview fingerprints', async () => {
    const original = [makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')];
    const replacement = [makeFile(`${ROOT}/project-001/project.json`, 'BBBBBBBBBBBBBBBB', 'application/json')];
    const first = await previewFiles(original, 0);
    const second = await previewFiles(replacement, 1);
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    const progress = createInitialAnnualIntakeProgress(first.plan, ['annual-2026/project-001'], []);
    expect(first.plan.cohortId).not.toBe(second.plan.cohortId);
    expect(canResumeAnnualIntake(progress, second.plan, ['annual-2026/project-001'], [])).toBe(false);

    const changedPreview = {
      ...second.plan,
      cohortId: first.plan.cohortId,
      chunks: second.plan.chunks.map((chunk) => ({ ...chunk, contentFingerprint: first.plan.chunks[chunk.index].contentFingerprint })),
    };
    expect(canResumeAnnualIntake(progress, changedPreview, ['annual-2026/project-001'], [])).toBe(false);
  });

  it('rejects a same-name/same-size replacement between preview and execution before staging', async () => {
    const result = await previewFiles([makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    result.plan.chunks[0].files[0] = makeFile(`${ROOT}/project-001/project.json`, 'BBBBBBBBBBBBBBBB', 'application/json');
    const stageRequests: string[] = [];
    const importResult = await runAnnualIntakeImport({
      plan: result.plan,
      selectedPackagePaths: [`${ROOT}/project-001`],
      acknowledgedWarningPackagePaths: [],
      fetchFn: async (input) => {
        stageRequests.push(String(input));
        return makeResponse({});
      },
      lockRunner: unlocked,
    });

    expect(importResult.success).toBe(false);
    expect(importResult.code).toBe('CONTENT_CHANGED');
    expect(stageRequests).toHaveLength(0);
  });

  it('fails closed for malformed persisted progress and refuses concurrent cohort advancement', async () => {
    const result = await previewFiles([makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const selected = ['annual-2026/project-001'];
    const valid = createInitialAnnualIntakeProgress(result.plan, selected, []);
    const malformed = { ...valid, chunks: [{ ...valid.chunks[0], contentFingerprint: 'not-a-sha256' }] };
    expect(canResumeAnnualIntake(malformed, result.plan, selected, [])).toBe(false);

    let malformedStoreRequests = 0;
    const malformedStore: AnnualIntakeProgressStore = {
      read: () => malformed,
      write: () => undefined,
    };
    const malformedRun = await runAnnualIntakeImport({
      plan: result.plan,
      selectedPackagePaths: selected,
      acknowledgedWarningPackagePaths: [],
      progressStore: malformedStore,
      fetchFn: async () => {
        malformedStoreRequests += 1;
        return makeResponse({});
      },
      lockRunner: unlocked,
    });
    expect(malformedRun.success).toBe(false);
    expect(malformedRun.code).toBe('PROGRESS_INVALID');
    expect(malformedStoreRequests).toBe(0);

    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const holdPromise = new Promise<void>((resolve) => { release = resolve; });
    let busy = false;
    const sharedLock: AnnualIntakeLockRunner = async (_cohortId, task) => {
      if (busy) return { acquired: false, reason: 'busy' };
      busy = true;
      entered();
      await holdPromise;
      try {
        return { acquired: true, value: await task() };
      } finally {
        busy = false;
      }
    };
    const store = memoryStore();
    const firstPromise = runAnnualIntakeImport({ plan: result.plan, selectedPackagePaths: selected, acknowledgedWarningPackagePaths: [], progressStore: store, fetchFn: async () => makeResponse({}), lockRunner: sharedLock });
    await enteredPromise;
    const second = await runAnnualIntakeImport({ plan: result.plan, selectedPackagePaths: selected, acknowledgedWarningPackagePaths: [], existingProgress: store.value, progressStore: store, fetchFn: async () => makeResponse({}), lockRunner: sharedLock });
    expect(second.success).toBe(false);
    expect(second.code).toBe('COHORT_IN_FLIGHT');
    release();
    await firstPromise;
  });

  it('fails closed when browser progress storage cannot be read or written', async () => {
    const result = await previewFiles([makeFile(`${ROOT}/project-001/project.json`, 'AAAAAAAAAAAAAAAA', 'application/json')]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const selected = [`${ROOT}/project-001`];
    let stageRequests = 0;
    const fetchFn: typeof fetch = async () => {
      stageRequests += 1;
      return makeResponse({});
    };

    const readStore = createBrowserAnnualIntakeProgressStore('annual-intake-read-failure');
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage read denied');
    });
    try {
      const readFailure = await runAnnualIntakeImport({
        plan: result.plan,
        selectedPackagePaths: selected,
        acknowledgedWarningPackagePaths: [],
        progressStore: readStore,
        fetchFn,
        lockRunner: unlocked,
      });
      expect(readFailure.success).toBe(false);
      expect(readFailure.code).toBe('PROGRESS_READ_FAILED');
      expect(readFailure.progress.chunks.every((chunk) => chunk.status === 'pending')).toBe(true);
    } finally {
      getItem.mockRestore();
    }

    const writeStore = createBrowserAnnualIntakeProgressStore('annual-intake-write-failure');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage write denied');
    });
    try {
      const writeFailure = await runAnnualIntakeImport({
        plan: result.plan,
        selectedPackagePaths: selected,
        acknowledgedWarningPackagePaths: [],
        progressStore: writeStore,
        fetchFn,
        lockRunner: unlocked,
      });
      expect(writeFailure.success).toBe(false);
      expect(writeFailure.code).toBe('PROGRESS_WRITE_FAILED');
      expect(writeFailure.progress.chunks.every((chunk) => chunk.status === 'pending')).toBe(true);
    } finally {
      setItem.mockRestore();
    }

    expect(stageRequests).toBe(0);
  });

  it('maps Web Locks unavailable, busy, and request rejection to safe outcomes', async () => {
    const restore = installNavigatorLocks({
      request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<void>) => callback(null),
    });
    try {
      const busy = await withAnnualIntakeInFlightLock('annual-test', async () => 'unexpected');
      expect(busy).toEqual({ acquired: false, reason: 'busy' });

      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
      const unavailable = await withAnnualIntakeInFlightLock('annual-test', async () => 'unexpected');
      expect(unavailable).toEqual({ acquired: false, reason: 'unavailable' });

      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: async () => { throw new Error('lock request rejected'); } },
      });
      const rejected = await withAnnualIntakeInFlightLock('annual-test', async () => 'unexpected');
      expect(rejected).toEqual({ acquired: false, reason: 'unavailable' });
    } finally {
      restore();
    }
  });
});

function makeAnnualComponentPlan(): AnnualIntakePreviewPlan {
  const packages = Array.from({ length: 26 }, (_, index) => {
    const packagePath = `${ROOT}/project-${String(index + 1).padStart(2, '0')}`;
    return {
      packagePath,
      folderName: packagePath.split('/')[1],
      proposedPublicId: packagePath.split('/')[1],
      metadataSource: 'json' as const,
      status: 'valid' as const,
      previewMetadata: {
        title: packagePath,
        year: '2026',
        program: 'Program',
        discipline: 'Discipline',
        groupName: packagePath,
        teamMemberCount: 1,
        layoutTemplate: 'poster_showcase',
        featuredMedia: 'poster',
      },
      filePresence: {
        xlsxPresent: false,
        jsonPresent: true,
        posterImagePresent: true,
        posterPdfPresent: false,
        snapshotPresent: false,
      },
      errors: [],
      warnings: [],
    };
  });

  const chunks = [packages.slice(0, 25), packages.slice(25)].map((chunkPackages, index) => ({
    index,
    packagePaths: chunkPackages.map((pkg) => pkg.packagePath),
    files: [],
    manifest: {
      selectedRootName: ROOT,
      fileCount: chunkPackages.length,
      declaredTotalBytes: chunkPackages.length,
      ignoredSystemFilesCount: 0,
      descriptors: [],
    },
    contentFingerprint: 'a'.repeat(64),
    preview: {
      previewFingerprint: `${String(index + 1).repeat(2)}${'b'.repeat(62)}`,
      mode: 'batch' as const,
      selectedRootName: ROOT,
      packageCount: chunkPackages.length,
      selectedFileCount: chunkPackages.length,
      declaredTotalBytes: chunkPackages.length,
      validPackageCount: chunkPackages.length,
      warningPackageCount: 0,
      invalidPackageCount: 0,
      totalWarnings: 0,
      totalErrors: 0,
      mediaValidationMode: 'descriptor_only' as const,
      batchIssues: [],
      packages: chunkPackages,
      adminReference: REFERENCE_INTENT,
    },
  }));

  return {
    cohortId: `annual-${'c'.repeat(64)}`,
    selectedRootName: ROOT,
    chunks,
    mergedPreview: {
      previewFingerprint: 'd'.repeat(64),
      mode: 'batch',
      selectedRootName: ROOT,
      packageCount: packages.length,
      selectedFileCount: packages.length,
      declaredTotalBytes: packages.length,
      validPackageCount: packages.length,
      warningPackageCount: 0,
      invalidPackageCount: 0,
      totalWarnings: 0,
      totalErrors: 0,
      mediaValidationMode: 'descriptor_only',
      batchIssues: [],
      packages,
      adminReference: REFERENCE_INTENT,
    },
  };
}

function makeSelectedAnnualComponentFiles(): File[] {
  return Array.from({ length: 26 }, (_, index) => {
    const packageName = `project-${String(index + 1).padStart(2, '0')}`;
    return makeFile(`${ROOT}/${packageName}/project.json`, 'metadata', 'application/json');
  });
}

const annualComponentStubs = {
  preview: vi.fn(),
  import: vi.fn(),
};

describe('Annual intake component verification authority', () => {
  it('keeps restored terminal progress resumable until authoritative import success', async () => {
    localStorage.clear();
    const plan = makeAnnualComponentPlan();
    const selected = plan.mergedPreview.packages.map((pkg) => pkg.packagePath);
    const restoredProgress = createInitialAnnualIntakeProgress(plan, selected, []);
    restoredProgress.chunks = restoredProgress.chunks.map((chunk, index) => ({
      ...chunk,
      status: 'completed',
      batchId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      mediaAssetCount: 1,
    }));
    localStorage.setItem(
      `admin-cms.annual-intake.v1.${plan.cohortId}`,
      JSON.stringify(restoredProgress),
    );

    const verifiedProgress: AnnualIntakeProgress = {
      ...restoredProgress,
      chunks: restoredProgress.chunks.map((chunk) => ({ ...chunk })),
    };
    annualComponentStubs.preview.mockReset();
    annualComponentStubs.import.mockReset();
    annualComponentStubs.preview.mockResolvedValue({ success: true, plan });
    annualComponentStubs.import.mockImplementation(async (params: {
      onProgress?: (progress: AnnualIntakeProgress) => void;
    }) => {
      params.onProgress?.(verifiedProgress);
      return { success: true, progress: verifiedProgress, error: null, failedChunkIndex: null };
    });

    vi.doMock('../annualIntakeOrchestration', () => ({
      runAnnualIntakePreview: annualComponentStubs.preview,
      runAnnualIntakeImport: annualComponentStubs.import,
    }));

    type ReferenceSectionProps = {
      onMappingConfigured: (value: {
        referenceFile: File;
        mappingConfig: AdminReferenceMappingConfig;
      } | null) => void;
      disabled?: boolean;
    };
    vi.doMock('../../components/imports/AdminReferenceDatasetSection', () => ({
      AdminReferenceDatasetSection: ({ onMappingConfigured, disabled }: ReferenceSectionProps) => React.createElement(
        'button',
        {
          type: 'button',
          disabled,
          onClick: () => onMappingConfigured({
            referenceFile: new File(['reference'], 'reference.xlsx'),
            mappingConfig: {
              worksheet: 'REFERENCE',
              matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
              comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Title' }],
              reconciliationContractVersion: 'admin-reference-reconciliation-v1',
            },
          }),
        },
        'Configure test reference',
      ),
    }));

    try {
      const { default: BrowserImportPreviewClient } = await import('../../components/imports/BrowserImportPreviewClient');
      render(React.createElement(BrowserImportPreviewClient));
      fireEvent.click(screen.getByRole('button', { name: 'Configure test reference' }));
      fireEvent.change(screen.getByLabelText('Upload project directory'), {
        target: { files: makeSelectedAnnualComponentFiles() },
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Preview annual intake' }));
      });

      await waitFor(() => expect(screen.getByText('Annual intake cohort ready')).toBeTruthy());
      expect(screen.queryByText(/All selected chunks completed and were verified by the server/i)).toBeNull();
      expect(screen.getByText(/Saved progress needs server verification/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Verify / Resume annual intake' })).toBeTruthy();
      expect(screen.queryByRole('link', { name: /Open chunk/i })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Verify / Resume annual intake' }));
      await waitFor(() => expect(annualComponentStubs.import).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByText(/All selected chunks completed and were verified by the server/i)).toBeTruthy());
      expect(screen.getByRole('link', { name: 'Open chunk 1' })).toBeTruthy();
    } finally {
      cleanup();
      localStorage.clear();
      vi.resetModules();
      vi.doUnmock('../annualIntakeOrchestration');
      vi.doUnmock('../../components/imports/AdminReferenceDatasetSection');
    }
  }, 15_000);
});
