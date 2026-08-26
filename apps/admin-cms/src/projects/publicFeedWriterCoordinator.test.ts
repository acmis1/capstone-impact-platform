import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockProject } from '../test/projectFixtures';
import { toPublicFeedRecord } from '../feed/compilePublicFeed';
import {
  composePublicFeedPublication,
  composePublicFeedRemoval,
  createPublicFeedArtifact,
  type VerifiedPublicFeedArtifact,
} from '../feed/publicFeedArtifact';
import type {
  PublicFeedOperationRecord,
  PublicFeedOperationState,
} from '../repositories/SupabasePublicFeedLedgerRepositoryCore';
import type { PublicationMediaBinding } from './publicationArtifact';

const harness = vi.hoisted(() => ({
  ledger: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  storage: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../repositories/SupabasePublicFeedLedgerRepositoryCore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../repositories/SupabasePublicFeedLedgerRepositoryCore')>()),
  SupabasePublicFeedLedgerRepositoryCore: class { constructor() { return harness.ledger as never; } },
}));
vi.mock('../storage/publicFeedStorage.private', () => ({
  PublicFeedStorageBoundary: class { constructor() { return harness.storage as never; } },
}));

import { executePublicFeedWriter } from './publicFeedWriterCoordinator';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN = '99999999-9999-4999-8999-999999999999';
const PREVIEW = '22222222-2222-4222-8222-222222222222';
const CONFIRMED_AT = '2026-08-24T00:00:00.000Z';
const BUCKET = 'feeds';
const PATH = 'feed.json';

const baseline = createPublicFeedArtifact([toPublicFeedRecord(createMockProject({ publicId: 'deployed', status: 'published' }))]);
const candidate = composePublicFeedPublication(
  baseline,
  createPublicFeedArtifact([toPublicFeedRecord(createMockProject({ publicId: 'target', status: 'published' }))]).feed[0],
);
const removalBaseline = createPublicFeedArtifact([
  toPublicFeedRecord(createMockProject({ publicId: 'deployed', status: 'published' })),
  toPublicFeedRecord(createMockProject({ publicId: 'target', status: 'published' })),
]);
const removalCandidate = composePublicFeedRemoval(removalBaseline, 'target');

function mediaBinding(overrides: Partial<PublicationMediaBinding> = {}): PublicationMediaBinding {
  return {
    mediaAssetId: '33333333-3333-4333-8333-333333333333', assetType: 'poster_image', galleryPosition: null,
    fileName: 'poster.png', mimeType: 'image/png', fileSizeBytes: 12,
    sourceBucket: 'private', sourcePath: 'drafts/target/poster.png',
    publicBucket: 'assets', publicPath: 'published/target/poster.png',
    publicUrl: 'https://example.com/published/target/poster.png', altTextPublic: 'Poster',
    preExisting: false, sourceSha256: 'a'.repeat(64), ...overrides,
  };
}

function operationRecord(state: PublicFeedOperationState, overrides: Partial<PublicFeedOperationRecord> = {}): PublicFeedOperationRecord {
  return {
    id: 'operation-1', operationKey: 'key-1', kind: 'publication', publicationMode: 'normal',
    authorizingActorId: ADMIN, completionActorId: null, projectId: null, publicId: 'target',
    rollbackPreparationId: null, confirmedPreviewId: PREVIEW, confirmedAt: CONFIRMED_AT,
    privateMediaBucket: 'private', archiveReason: null, rollbackCapabilityRequested: false,
    baselineVersionId: 'version-1', baselineStorageExisted: true,
    baselineFeedHash: baseline.feedHash, baselineRecordCount: baseline.recordCount,
    baselineFeedContent: baseline.content, candidateFeedHash: candidate.feedHash,
    candidateRecordCount: candidate.recordCount, candidateFeedContent: candidate.content,
    mediaManifest: [mediaBinding()], state, ownerEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), storageUncertaintyUntil: null,
    storageRequestGeneration: 0, recoveryFromState: null, storageBucket: BUCKET, storagePath: PATH,
    feedPublicUrl: 'https://example.com/feed.json', failureCode: null, ...overrides,
  };
}

function createStorage(initial: VerifiedPublicFeedArtifact | null) {
  let stored = initial === null ? null : Buffer.from(initial.bytes);
  return {
    readExact: vi.fn(async () => stored),
    writeExact: vi.fn(async (_bucket: string, _path: string, bytes: Buffer) => { stored = Buffer.from(bytes); }),
    getPublicUrl: vi.fn(() => 'https://example.com/feed.json'),
  };
}

function createLedger(initialState: PublicFeedOperationState, overrides: Partial<PublicFeedOperationRecord> = {}) {
  let record = operationRecord(initialState, overrides);
  const advance = (state: PublicFeedOperationState) => { record = { ...record, state }; };
  return {
    getBlockingOperation: vi.fn(async () => null),
    getOperation: vi.fn(async () => ({ ...record })),
    getHead: vi.fn(async () => ({
      generation: 1, rollbackEnabled: false,
      currentVersion: {
        id: 'version-1', versionNumber: 1, operation: 'baseline' as const, publicationMode: null,
        operationId: 'baseline-operation', previousVersionId: null, restoredFromVersionId: null,
        projectId: null, affectedPublicId: null, authorizingActorId: ADMIN, completionActorId: ADMIN,
        artifactContent: baseline.content, byteCount: baseline.bytes.byteLength,
        feedHash: baseline.feedHash, recordCount: baseline.recordCount,
        publishedSnapshotId: null, auditRecordId: null, createdAt: CONFIRMED_AT,
      },
    })),
    getVersionByOperationId: vi.fn(async () => ({
      id: 'version-2', versionNumber: 2, operation: 'publication' as const, publicationMode: 'normal' as const,
      operationId: record.id, previousVersionId: 'version-1', restoredFromVersionId: null,
      projectId: null, affectedPublicId: 'target', authorizingActorId: ADMIN, completionActorId: OTHER_ADMIN,
      artifactContent: candidate.content, byteCount: candidate.bytes.byteLength,
      feedHash: candidate.feedHash, recordCount: candidate.recordCount,
      publishedSnapshotId: 'snapshot-A', auditRecordId: 'audit-A', createdAt: CONFIRMED_AT,
    })),
    reserve: vi.fn(async () => ({ resultCode: 'OPERATION_RESERVED', operationId: record.id, ownerEpoch: 1 })),
    claim: vi.fn(async () => ({ resultCode: 'OPERATION_CLAIMED', ownerEpoch: 2 })),
    bind: vi.fn(async () => { advance('PREPARED'); return { resultCode: 'ARTIFACT_BOUND' }; }),
    renew: vi.fn(async () => ({ resultCode: 'LEASE_RENEWED' })),
    markWriteStarted: vi.fn(async () => { advance('WRITE_STARTED'); return { resultCode: 'WRITE_STARTED' }; }),
    observeCandidate: vi.fn(async () => { advance('CANDIDATE_OBSERVED'); return { resultCode: 'CANDIDATE_OBSERVED' }; }),
    finalize: vi.fn(async () => {
      advance('DB_FINALIZED');
      return { resultCode: 'DB_FINALIZED', versionNumber: 2, snapshotId: 'snapshot-A', auditRecordId: 'audit-A' };
    }),
    complete: vi.fn(async () => { advance('COMPLETED'); return { resultCode: 'COMPLETED' }; }),
    fail: vi.fn(async () => { advance('FAILED'); return { resultCode: 'FAILED' }; }),
    requireRecovery: vi.fn(async () => { advance('RECOVERY_REQUIRED'); return { resultCode: 'RECOVERY_REQUIRED' }; }),
  };
}

function writerParameters(overrides: Record<string, unknown> = {}) {
  return {
    supabase: {} as SupabaseClient, adminId: ADMIN, kind: 'publication' as const,
    publicationMode: 'normal' as const, publicId: 'target', confirmedPreviewId: PREVIEW,
    confirmedAt: CONFIRMED_AT, privateBucket: 'private', feedBucket: BUCKET, feedPath: PATH,
    prepareCandidate: async () => ({ artifact: candidate, mediaManifest: [mediaBinding()] }),
    ...overrides,
  };
}

function removalParameters(overrides: Record<string, unknown> = {}) {
  return writerParameters({
    kind: 'removal', publicationMode: undefined, confirmedPreviewId: undefined,
    confirmedAt: undefined, privateBucket: undefined, archiveReason: 'Archive target',
    prepareCandidate: async () => ({ artifact: removalCandidate }),
    ...overrides,
  });
}

function removalOperationOverrides(): Partial<PublicFeedOperationRecord> {
  return {
    kind: 'removal', publicationMode: null, confirmedPreviewId: null, confirmedAt: null,
    privateMediaBucket: null, archiveReason: 'Archive target', mediaManifest: [],
    baselineFeedHash: removalBaseline.feedHash,
    baselineRecordCount: removalBaseline.recordCount,
    baselineFeedContent: removalBaseline.content,
    candidateFeedHash: removalCandidate.feedHash,
    candidateRecordCount: removalCandidate.recordCount,
    candidateFeedContent: removalCandidate.content,
  };
}

describe('canonical public feed writer boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries deployment reconciliation intent, including exact confirmation evidence, into reservation', async () => {
    harness.ledger = createLedger('RESERVED', { publicationMode: 'deployment_reconciliation' });
    harness.storage = createStorage(baseline);

    const result = await executePublicFeedWriter(writerParameters({
      publicationMode: 'deployment_reconciliation',
      afterWriteIntent: async () => undefined,
    }) as never);

    expect(result.resultCode).toBe('COMPLETED');
    expect(harness.ledger.reserve).toHaveBeenCalledTimes(1);
    expect(harness.ledger.reserve.mock.calls[0][0]).toMatchObject({
      kind: 'publication',
      mode: 'deployment_reconciliation',
      publicId: 'target',
      confirmedPreviewId: PREVIEW,
      confirmedAt: CONFIRMED_AT,
    });
  });

  it('creates zero public media and writes no feed when the database refuses reconciliation write intent', async () => {
    harness.ledger = createLedger('PREPARED', { publicationMode: 'deployment_reconciliation' });
    harness.ledger.markWriteStarted = vi.fn(async () => ({ resultCode: 'NOT_READY' }));
    harness.storage = createStorage(baseline);
    const validateBeforeWriteIntent = vi.fn(async () => undefined);
    const afterWriteIntent = vi.fn(async () => undefined);

    const result = await executePublicFeedWriter(writerParameters({
      publicationMode: 'deployment_reconciliation',
      validateBeforeWriteIntent, afterWriteIntent,
    }) as never);

    expect(result).toEqual({ resultCode: 'NOT_READY' });
    // The pre-write revalidation is the last boundary: nothing public may exist after it refuses,
    // and the refused operation is closed out rather than left holding the writer.
    expect(validateBeforeWriteIntent).toHaveBeenCalledTimes(1);
    expect(harness.ledger.fail).toHaveBeenCalledTimes(1);
    expect(afterWriteIntent).not.toHaveBeenCalled();
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('exposes no public media until write intent is durable, then writes the feed after it', async () => {
    harness.ledger = createLedger('RESERVED');
    harness.storage = createStorage(baseline);
    const order: string[] = [];
    const result = await executePublicFeedWriter(writerParameters({
      validateBeforeWriteIntent: async () => { order.push('validate'); },
      afterWriteIntent: async () => { order.push('promote'); },
    }) as never);

    expect(result).toMatchObject({ resultCode: 'COMPLETED', snapshotId: 'snapshot-A', auditRecordId: 'audit-A' });
    const writeIntentIndex = harness.ledger.markWriteStarted.mock.invocationCallOrder[0];
    const promoteIndex = harness.storage.writeExact.mock.invocationCallOrder[0];
    expect(order).toEqual(['validate', 'promote']);
    expect(writeIntentIndex).toBeLessThan(promoteIndex);
  });

  it('makes no public media readable when the owner lease was already reclaimed', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.renew = vi.fn(async () => ({ resultCode: 'STALE_OWNER' }));
    harness.storage = createStorage(baseline);
    const afterWriteIntent = vi.fn(async () => undefined);

    await expect(executePublicFeedWriter(writerParameters({ afterWriteIntent }) as never))
      .resolves.toEqual({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    expect(afterWriteIntent).not.toHaveBeenCalled();
    expect(harness.ledger.markWriteStarted).not.toHaveBeenCalled();
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('makes no public media readable when publication authority was revoked at the write-intent gate', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.markWriteStarted = vi.fn(async () => ({ resultCode: 'PERMISSION_DENIED' }));
    harness.storage = createStorage(baseline);
    const afterWriteIntent = vi.fn(async () => undefined);
    const validateBeforeWriteIntent = vi.fn(async () => undefined);

    await expect(executePublicFeedWriter(writerParameters({ afterWriteIntent, validateBeforeWriteIntent }) as never))
      .resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(validateBeforeWriteIntent).toHaveBeenCalledOnce();
    expect(harness.ledger.fail).toHaveBeenCalledWith(
      'operation-1', 1, expect.any(String), ADMIN, 'PERMISSION_DENIED',
    );
    expect(afterWriteIntent).not.toHaveBeenCalled();
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('returns permission denial when the fenced failure committed but its response was lost', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.markWriteStarted = vi.fn(async () => ({ resultCode: 'PERMISSION_DENIED' }));
    harness.ledger.fail = vi.fn(async () => { throw new Error('PERSISTENCE_RESPONSE_LOST'); });
    harness.ledger.getOperation
      .mockResolvedValueOnce(operationRecord('PREPARED'))
      .mockResolvedValueOnce(operationRecord('FAILED', { failureCode: 'PERMISSION_DENIED' }));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({
      afterWriteIntent: async () => undefined,
    }) as never)).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('makes no public media readable when readiness was revoked at the write-intent gate', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.markWriteStarted = vi.fn(async () => ({ resultCode: 'NOT_READY' }));
    harness.storage = createStorage(baseline);
    const afterWriteIntent = vi.fn(async () => undefined);

    await expect(executePublicFeedWriter(writerParameters({ afterWriteIntent }) as never))
      .resolves.toEqual({ resultCode: 'NOT_READY' });
    expect(afterWriteIntent).not.toHaveBeenCalled();
    expect(harness.ledger.fail).toHaveBeenCalledOnce();
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('fails closed with zero public side effects when private source bytes changed after binding', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.storage = createStorage(baseline);
    const afterWriteIntent = vi.fn(async () => undefined);

    await expect(executePublicFeedWriter(writerParameters({
      afterWriteIntent,
      validateBeforeWriteIntent: async () => { throw new Error('PRIVATE_MEDIA_CHANGED'); },
    }) as never)).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'PRIVATE_MEDIA_CHANGED' });
    expect(afterWriteIntent).not.toHaveBeenCalled();
    expect(harness.ledger.markWriteStarted).not.toHaveBeenCalled();
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
    expect(harness.ledger.fail).toHaveBeenCalledOnce();
  });

  it('parks a partially promoted manifest in durable recovery rather than deleting public objects', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({
      afterWriteIntent: async () => { throw new Error('PUBLIC_MEDIA_VERIFICATION_FAILED'); },
    }) as never)).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(harness.ledger.requireRecovery).toHaveBeenCalledWith(
      'operation-1', 1, expect.any(String), ADMIN, 'PUBLIC_MEDIA_VERIFICATION_FAILED', null, null,
    );
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('replays the durable manifest and finishes the canonical write after a crash past write intent', async () => {
    harness.ledger = createLedger('WRITE_STARTED');
    harness.storage = createStorage(baseline);
    const afterWriteIntent = vi.fn(async () => undefined);

    const result = await executePublicFeedWriter(writerParameters({
      afterWriteIntent,
      prepareCandidate: async () => { throw new Error('RECOVERY_ARTIFACT_MUST_BE_DURABLE'); },
    }) as never);

    expect(result).toMatchObject({ resultCode: 'COMPLETED' });
    expect(afterWriteIntent).toHaveBeenCalledOnce();
    expect(harness.storage.writeExact).toHaveBeenCalledOnce();
  });

  it('completes normally when a caught write error can read back the exact committed candidate', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.storage = createStorage(baseline);
    const committedWrite = harness.storage.writeExact as (
      bucket: string, path: string, bytes: Buffer,
    ) => Promise<void>;
    harness.storage.writeExact = vi.fn(async (...args: [string, string, Buffer]) => {
      await committedWrite(...args);
      throw new Error('SIMULATED_TIMEOUT_AFTER_COMMIT');
    });

    await expect(executePublicFeedWriter(writerParameters({
      afterWriteIntent: async () => undefined,
    }) as never)).resolves.toMatchObject({ resultCode: 'COMPLETED' });
    expect(harness.ledger.requireRecovery).not.toHaveBeenCalled();
  });

  it('parks a caught ambiguous write when the subsequent Storage observation is unavailable', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.storage = createStorage(baseline);
    let writeAttempted = false;
    harness.storage.writeExact = vi.fn(async () => {
      writeAttempted = true;
      throw new Error('SIMULATED_WRITE_FAILURE');
    });
    harness.storage.readExact = vi.fn(async () => {
      if (writeAttempted) throw new Error('SIMULATED_OBSERVATION_UNAVAILABLE');
      return baseline.bytes;
    });

    await expect(executePublicFeedWriter(writerParameters({
      afterWriteIntent: async () => undefined,
    }) as never)).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(harness.ledger.requireRecovery).toHaveBeenCalledWith(
      'operation-1', 1, expect.any(String), ADMIN,
      'STORAGE_WRITE_OUTCOME_UNCERTAIN', null, null,
    );
  });

  it('requires explicit exact-intent recovery after a caught removal write leaves the baseline', async () => {
    harness.ledger = createLedger('PREPARED', removalOperationOverrides());
    harness.storage = createStorage(removalBaseline);
    const normalWrite = harness.storage.writeExact;
    harness.storage.writeExact = vi.fn(async () => { throw new Error('SIMULATED_WRITE_FAILURE'); });

    await expect(executePublicFeedWriter(removalParameters() as never))
      .resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(harness.ledger.requireRecovery).toHaveBeenCalledWith(
      'operation-1', 1, expect.any(String), ADMIN,
      'STORAGE_WRITE_OUTCOME_UNCERTAIN', removalBaseline.feedHash, removalBaseline.recordCount,
    );

    const getOperation = harness.ledger.getOperation as () => Promise<PublicFeedOperationRecord>;
    harness.ledger.getBlockingOperation = vi.fn(async () => ({
      ...(await getOperation()),
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    await expect(executePublicFeedWriter(removalParameters() as never))
      .resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    await expect(executePublicFeedWriter(removalParameters({
      recoveryOperationId: 'operation-1', archiveReason: 'Different reason',
    }) as never)).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    await expect(executePublicFeedWriter(removalParameters({
      recoveryOperationId: 'operation-1', publicId: 'different-target',
    }) as never)).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(harness.ledger.claim).not.toHaveBeenCalled();

    harness.storage.writeExact = normalWrite;
    await expect(executePublicFeedWriter(removalParameters({
      recoveryOperationId: 'operation-1',
    }) as never)).resolves.toMatchObject({ resultCode: 'COMPLETED' });
    expect(harness.storage.writeExact).toHaveBeenCalledOnce();
  });

  it('refuses to advance a bound media manifest without a promotion capability', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters() as never))
      .resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'MEDIA_PROMOTION_UNAVAILABLE' });
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });
});

describe('durable operation intent binding', () => {
  beforeEach(() => vi.clearAllMocks());

  function expiredBlocking(overrides: Partial<PublicFeedOperationRecord> = {}) {
    return operationRecord('PREPARED', {
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(), ...overrides,
    });
  }

  const mismatches: Array<[string, Partial<PublicFeedOperationRecord>, Record<string, unknown>]> = [
    ['publication mode', { publicationMode: 'deployment_reconciliation' }, {}],
    ['confirmed preview evidence', { confirmedPreviewId: '44444444-4444-4444-8444-444444444444' }, {}],
    ['confirmation timestamp', { confirmedAt: '2026-08-25T00:00:00.000Z' }, {}],
    ['private media bucket', { privateMediaBucket: 'other-private' }, {}],
    ['authorizing administrator', { authorizingActorId: OTHER_ADMIN }, {}],
    ['canonical storage path', { storagePath: 'other-feed.json' }, {}],
  ];

  it.each(mismatches)('refuses to adopt an expired operation with a different %s', async (_label, durable) => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.getBlockingOperation = vi.fn(async () => expiredBlocking(durable));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({ afterWriteIntent: async () => undefined }) as never))
      .resolves.toEqual({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    expect(harness.ledger.claim).not.toHaveBeenCalled();
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('refuses to adopt an expired removal carrying a different archive reason', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.getBlockingOperation = vi.fn(async () => expiredBlocking({
      kind: 'removal', publicationMode: null, confirmedPreviewId: null, confirmedAt: null,
      privateMediaBucket: null, archiveReason: 'Superseded by a corrected record', mediaManifest: [],
    }));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({
      kind: 'removal', publicationMode: undefined, confirmedPreviewId: undefined,
      confirmedAt: undefined, privateBucket: undefined, archiveReason: 'Withdrawn by the participant',
      prepareCandidate: async () => ({ artifact: candidate }),
    }) as never)).resolves.toEqual({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    expect(harness.ledger.claim).not.toHaveBeenCalled();
  });

  it('claims an expired operation whose complete immutable intent matches', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.getBlockingOperation = vi.fn(async () => expiredBlocking());
    harness.storage = createStorage(baseline);

    const result = await executePublicFeedWriter(writerParameters({
      afterWriteIntent: async () => undefined,
    }) as never);
    expect(result).toMatchObject({ resultCode: 'COMPLETED' });
    expect(harness.ledger.claim).toHaveBeenCalledOnce();
  });

  it('allows an explicit current-admin takeover while preserving the original authorization intent', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.getBlockingOperation = vi.fn(async () => expiredBlocking());
    harness.storage = createStorage(baseline);

    const result = await executePublicFeedWriter(writerParameters({
      adminId: OTHER_ADMIN, recoveryOperationId: 'operation-1',
      afterWriteIntent: async () => undefined,
    }) as never);

    expect(result).toMatchObject({ resultCode: 'COMPLETED' });
    expect(harness.ledger.claim).toHaveBeenCalledWith('operation-1', OTHER_ADMIN, expect.any(String));
    expect(harness.ledger.finalize).toHaveBeenCalledWith(
      'operation-1', 2, expect.any(String), OTHER_ADMIN,
    );
    expect(expiredBlocking().authorizingActorId).toBe(ADMIN);
  });

  it.each(['WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED'] as const)(
    'converges an expired %s operation under an explicit second-admin takeover',
    async (state) => {
      harness.ledger = createLedger(state);
      harness.ledger.getBlockingOperation = vi.fn(async () => operationRecord(state, {
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }));
      harness.storage = createStorage(state === 'WRITE_STARTED' ? baseline : candidate);

      const result = await executePublicFeedWriter(writerParameters({
        adminId: OTHER_ADMIN, recoveryOperationId: 'operation-1',
        afterWriteIntent: async () => undefined,
        prepareCandidate: async () => { throw new Error('RECOVERY_ARTIFACT_MUST_BE_DURABLE'); },
      }) as never);

      expect(result).toMatchObject({ resultCode: 'COMPLETED', versionNumber: 2 });
      expect(harness.ledger.claim).toHaveBeenCalledWith('operation-1', OTHER_ADMIN, expect.any(String));
      expect(harness.ledger.complete).toHaveBeenCalledWith(
        'operation-1', 2, expect.any(String), OTHER_ADMIN, candidate.feedHash, candidate.recordCount,
      );
    },
  );

  it('does not steal a non-expired explicitly named operation', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.getBlockingOperation = vi.fn(async () => operationRecord('PREPARED'));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({
      adminId: OTHER_ADMIN, recoveryOperationId: 'operation-1', afterWriteIntent: async () => undefined,
    }) as never)).resolves.toEqual({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    expect(harness.ledger.claim).not.toHaveBeenCalled();
  });

  it('denies an explicit takeover when the claim actor is not a current admin', async () => {
    harness.ledger = createLedger('PREPARED');
    harness.ledger.getBlockingOperation = vi.fn(async () => expiredBlocking());
    harness.ledger.claim = vi.fn(async () => ({ resultCode: 'PERMISSION_DENIED' }));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({
      adminId: OTHER_ADMIN, recoveryOperationId: 'operation-1', afterWriteIntent: async () => undefined,
    }) as never)).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('respects the Storage uncertainty fence during explicit takeover', async () => {
    harness.ledger = createLedger('WRITE_STARTED');
    harness.ledger.getBlockingOperation = vi.fn(async () => operationRecord('WRITE_STARTED', {
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      storageUncertaintyUntil: new Date(Date.now() + 60_000).toISOString(),
    }));
    harness.ledger.claim = vi.fn(async () => ({ resultCode: 'UNCERTAINTY_FENCE_ACTIVE' }));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({
      adminId: OTHER_ADMIN, recoveryOperationId: 'operation-1', afterWriteIntent: async () => undefined,
    }) as never)).resolves.toEqual({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    expect(harness.storage.writeExact).not.toHaveBeenCalled();
  });

  it('holds a recovery-required operation until the operator names it explicitly', async () => {
    harness.ledger = createLedger('RECOVERY_REQUIRED');
    harness.ledger.getBlockingOperation = vi.fn(async () => operationRecord('RECOVERY_REQUIRED', {
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({ afterWriteIntent: async () => undefined }) as never))
      .resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(harness.ledger.claim).not.toHaveBeenCalled();
  });

  it('refuses an explicitly named recovery whose incoming intent contradicts the durable record', async () => {
    harness.ledger = createLedger('RECOVERY_REQUIRED');
    harness.ledger.getBlockingOperation = vi.fn(async () => operationRecord('RECOVERY_REQUIRED', {
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      publicationMode: 'deployment_reconciliation',
    }));
    harness.storage = createStorage(baseline);

    await expect(executePublicFeedWriter(writerParameters({
      recoveryOperationId: 'operation-1', afterWriteIntent: async () => undefined,
    }) as never)).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(harness.ledger.claim).not.toHaveBeenCalled();
  });
});
