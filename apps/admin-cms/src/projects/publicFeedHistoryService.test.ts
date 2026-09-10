import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { toPublicFeedRecord } from '../feed/compilePublicFeed';
import { createMockProject } from '../test/projectFixtures';

const mocks = vi.hoisted(() => ({
  executePublicFeedWriter: vi.fn(),
  getBlockingOperation: vi.fn(),
  getOperation: vi.fn(),
  claim: vi.fn(),
  fail: vi.fn(),
  getRollbackPreparation: vi.fn(),
  getVersionByNumber: vi.fn(),
  getVersionById: vi.fn(),
  getVersionByOperationId: vi.fn(),
  getHead: vi.fn(),
  prepareRollback: vi.fn(),
  prepareVerifiedStagingRollback: vi.fn(),
  isCurrentVerifiedStagingRollbackCapabilityEnabled: vi.fn(async () => true),
  isVerifiedStagingRollbackOperationAuthorized: vi.fn(async () => true),
  transitionRollbackCapability: vi.fn(),
  inspectPublicFeedHead: vi.fn(),
}));

vi.mock('../repositories/SupabasePublicFeedLedgerRepositoryCore', () => ({
  SupabasePublicFeedLedgerRepositoryCore: class {
    getBlockingOperation = mocks.getBlockingOperation;
    getOperation = mocks.getOperation;
    claim = mocks.claim;
    fail = mocks.fail;
    getRollbackPreparation = mocks.getRollbackPreparation;
    getVersionByNumber = mocks.getVersionByNumber;
    getVersionById = mocks.getVersionById;
    getVersionByOperationId = mocks.getVersionByOperationId;
    getHead = mocks.getHead;
    prepareRollback = mocks.prepareRollback;
    prepareVerifiedStagingRollback = mocks.prepareVerifiedStagingRollback;
    isCurrentVerifiedStagingRollbackCapabilityEnabled = mocks.isCurrentVerifiedStagingRollbackCapabilityEnabled;
    isVerifiedStagingRollbackOperationAuthorized = mocks.isVerifiedStagingRollbackOperationAuthorized;
    transitionRollbackCapability = mocks.transitionRollbackCapability;
  },
}));

vi.mock('./publicFeedWriterCoordinator', () => ({
  executePublicFeedWriter: mocks.executePublicFeedWriter,
  inspectPublicFeedHead: mocks.inspectPublicFeedHead,
}));

import {
  activatePublicFeedHistory,
  executePublicFeedRollback,
  preparePublicFeedRollback,
  recoverPublicFeedOperation,
  requiredPublicFeedRollbackCapabilityConfirmation,
  transitionPublicFeedRollbackCapability,
  type PublicFeedHistoryServiceDependencies,
} from './publicFeedHistoryService';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN = '22222222-2222-4222-8222-222222222222';
const HANDLE = '33333333-3333-4333-8333-333333333333';
const ACKNOWLEDGEMENT = 'ROLL BACK TO VERSION 1';
const TARGET = createPublicFeedArtifact([]);

function dependencies(overrides: Partial<PublicFeedHistoryServiceDependencies> = {}): PublicFeedHistoryServiceDependencies {
  return {
    supabase: {} as never,
    supabaseUrl: 'http://127.0.0.1:54321',
    adminId: ADMIN,
    permissions: ['projects.publish'],
    feedBucket: 'public-feed',
    feedPath: 'feed.json',
    listProjects: vi.fn(),
    assertActivationEnvironment: vi.fn(),
    environment: {
      CAPSTONE_RUNTIME_ENV: 'local',
      CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
    },
    ...overrides,
  };
}

function durableOperation(state: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'operation-id', kind: 'publication', state,
    publicationMode: 'normal', publicId: 'synthetic-project', rollbackPreparationId: null,
    authorizingActorId: ADMIN, completionActorId: null,
    confirmedPreviewId: 'preview-id', confirmedAt: '2026-08-24T00:00:00.000Z',
    privateMediaBucket: 'private', archiveReason: null, rollbackCapabilityRequested: false,
    baselineVersionId: 'baseline-version', candidateFeedContent: TARGET.content,
    candidateFeedHash: TARGET.feedHash, candidateRecordCount: TARGET.recordCount,
    storageBucket: 'public-feed', storagePath: 'feed.json', ...overrides,
  };
}

function preparation(overrides: Record<string, unknown> = {}) {
  return {
    handle: HANDLE, actorId: ADMIN, targetVersionId: 'target-version',
    baselineVersionId: 'baseline-version',
    acknowledgementDigest: createHash('sha256').update(ACKNOWLEDGEMENT).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), consumedAt: null, operationId: null,
    ...overrides,
  };
}

function targetVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'target-version', versionNumber: 1, operation: 'baseline', publicationMode: null,
    operationId: 'activation-operation', previousVersionId: null, restoredFromVersionId: null,
    projectId: null, affectedPublicId: null, authorizingActorId: ADMIN, completionActorId: ADMIN,
    artifactContent: TARGET.content, byteCount: TARGET.bytes.byteLength,
    feedHash: TARGET.feedHash, recordCount: TARGET.recordCount,
    publishedSnapshotId: null, auditRecordId: null, createdAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function rollbackHead(overrides: Record<string, unknown> = {}) {
  return {
    generation: 2,
    rollbackEnabled: true,
    currentVersion: targetVersion({ id: 'baseline-version', versionNumber: 2 }),
    ...overrides,
  };
}

describe('activatePublicFeedHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHead.mockResolvedValue(null);
    mocks.executePublicFeedWriter.mockResolvedValue({
      resultCode: 'COMPLETED', versionNumber: 1,
      feedHash: TARGET.feedHash, recordCount: TARGET.recordCount,
    });
  });

  it('derives the only legacy upgrade target from the server lifecycle projection', async () => {
    const project = createMockProject({ publicId: 'published-project', status: 'published' });
    const listProjects = vi.fn(async () => [project]);
    const result = await activatePublicFeedHistory(dependencies({
      listProjects,
    }));

    expect(result.resultCode).toBe('COMPLETED');
    const parameters = mocks.executePublicFeedWriter.mock.calls[0][0];
    const projection = createPublicFeedArtifact([toPublicFeedRecord(project)]);
    expect(parameters).toMatchObject({
      kind: 'activation', legacyActivationTarget: expect.objectContaining({ content: projection.content }),
      feedBucket: 'public-feed', feedPath: 'feed.json',
    });
    await expect(parameters.prepareCandidate(projection)).resolves.toEqual({ artifact: projection });
    await expect(parameters.validateBeforeWriteIntent([])).resolves.toBeUndefined();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('fails the last pre-write authority check when lifecycle state drifts after binding', async () => {
    const before = createMockProject({ publicId: 'published-project', status: 'published' });
    const after = createMockProject({
      publicId: 'published-project', status: 'published', title: 'Changed after binding',
    });
    const listProjects = vi.fn()
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([after]);

    await activatePublicFeedHistory(dependencies({ listProjects }));
    const parameters = mocks.executePublicFeedWriter.mock.calls[0][0];

    await expect(parameters.validateBeforeWriteIntent([]))
      .rejects.toThrowError('LIFECYCLE_STORAGE_MISMATCH');
  });

  it('never auto-enables rollback while activating staging history', async () => {
    const project = createMockProject({ publicId: 'staging-project', status: 'published' });

    await activatePublicFeedHistory(dependencies({
      supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
      listProjects: async () => [project],
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-a06-staging.supabase.co',
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    }));

    expect(mocks.executePublicFeedWriter).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'activation', rollbackCapability: false,
    }));
  });

  it('keeps an existing strict head idempotent without compiling a replacement projection', async () => {
    const head = {
      generation: 1, rollbackEnabled: false,
      currentVersion: targetVersion(),
    };
    const listProjects = vi.fn();
    mocks.getHead.mockResolvedValue(head);
    mocks.inspectPublicFeedHead.mockResolvedValue({
      head, artifact: TARGET, publicUrl: 'https://example.com/feed.json',
    });

    await expect(activatePublicFeedHistory(dependencies({ listProjects }))).resolves.toEqual({
      resultCode: 'ALREADY_ACTIVE', versionNumber: 1,
      feedHash: TARGET.feedHash, recordCount: TARGET.recordCount,
    });
    expect(listProjects).not.toHaveBeenCalled();
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });
});

describe('recoverPublicFeedOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isVerifiedStagingRollbackOperationAuthorized.mockResolvedValue(true);
    mocks.getBlockingOperation.mockResolvedValue(null);
    mocks.getOperation.mockResolvedValue(null);
    mocks.claim.mockResolvedValue({ resultCode: 'OPERATION_CLAIMED', ownerEpoch: 2 });
    mocks.fail.mockResolvedValue({ resultCode: 'FAILED' });
    mocks.executePublicFeedWriter.mockResolvedValue({
      resultCode: 'COMPLETED', versionNumber: 2, feedHash: TARGET.feedHash,
      recordCount: TARGET.recordCount,
    });
  });

  it('keeps rollback recovery blocked outside an explicitly verified rollback environment', async () => {
    mocks.getBlockingOperation.mockResolvedValue(durableOperation('RECOVERY_REQUIRED', {
      kind: 'rollback', publicationMode: null, publicId: null, rollbackPreparationId: HANDLE,
    }));

    const result = await recoverPublicFeedOperation(dependencies({
      supabaseUrl: 'https://staging.example.supabase.co',
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    }));

    expect(result).toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });

  it('rechecks verified staging and database capability before rollback recovery', async () => {
    const operation = durableOperation('RECOVERY_REQUIRED', {
      kind: 'rollback', publicationMode: null, publicId: null, rollbackPreparationId: HANDLE,
    });
    mocks.getBlockingOperation.mockResolvedValue(operation);
    mocks.getHead.mockResolvedValue(rollbackHead());

    const result = await recoverPublicFeedOperation(dependencies({
      supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-a06-staging.supabase.co',
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    }));

    expect(result.resultCode).toBe('COMPLETED');
    expect(mocks.isVerifiedStagingRollbackOperationAuthorized).toHaveBeenCalledWith(operation);
    const parameters = mocks.executePublicFeedWriter.mock.calls[0][0];
    await expect(parameters.validateBeforeWriteIntent([])).resolves.toBeUndefined();
    expect(mocks.getHead).toHaveBeenCalledOnce();
    expect(mocks.isVerifiedStagingRollbackOperationAuthorized).toHaveBeenCalledTimes(2);
  });

  it('leaves rollback recovery required when the database head capability is disabled', async () => {
    mocks.getBlockingOperation.mockResolvedValue(durableOperation('RECOVERY_REQUIRED', {
      kind: 'rollback', publicationMode: null, publicId: null, rollbackPreparationId: HANDLE,
    }));
    mocks.getHead.mockResolvedValue(rollbackHead({ rollbackEnabled: false }));

    await expect(recoverPublicFeedOperation(dependencies()))
      .resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });

  it('passes an expired bound operation to the coordinator as an explicit exact-intent takeover', async () => {
    const operation = durableOperation('PREPARED');
    mocks.getBlockingOperation.mockResolvedValue(operation);

    await expect(recoverPublicFeedOperation(dependencies({ adminId: OTHER_ADMIN }))).resolves.toMatchObject({
      resultCode: 'COMPLETED', versionNumber: 2,
    });
    expect(mocks.executePublicFeedWriter).toHaveBeenCalledWith(expect.objectContaining({
      adminId: OTHER_ADMIN,
      recoveryOperationId: 'operation-id',
      kind: operation.kind,
      publicationMode: operation.publicationMode,
      publicId: operation.publicId,
      confirmedPreviewId: operation.confirmedPreviewId,
      confirmedAt: operation.confirmedAt,
      privateBucket: operation.privateMediaBucket,
    }));
  });

  it('claims and terminalizes an expired abandoned reservation without writing Storage', async () => {
    const operation = durableOperation('RESERVED', { candidateFeedContent: null });
    mocks.getBlockingOperation.mockResolvedValue(operation);
    mocks.getOperation.mockResolvedValue(operation);

    await expect(recoverPublicFeedOperation(dependencies({ adminId: OTHER_ADMIN })))
      .resolves.toEqual({ resultCode: 'RELEASED' });
    expect(mocks.claim).toHaveBeenCalledWith('operation-id', OTHER_ADMIN, expect.any(String));
    expect(mocks.fail).toHaveBeenCalledWith(
      'operation-id', 2, expect.any(String), OTHER_ADMIN, 'ABANDONED_PRE_WRITE_OPERATION',
    );
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });

  it.each(['PUBLICATION_IN_PROGRESS', 'UNCERTAINTY_FENCE_ACTIVE'])(
    'does not take over when claim returns %s',
    async (resultCode) => {
      mocks.getBlockingOperation.mockResolvedValue(durableOperation('RESERVED', { candidateFeedContent: null }));
      mocks.claim.mockResolvedValue({ resultCode });

      await expect(recoverPublicFeedOperation(dependencies()))
        .resolves.toEqual({ resultCode: 'PUBLICATION_IN_PROGRESS' });
      expect(mocks.fail).not.toHaveBeenCalled();
    },
  );

  it('denies takeover before inspecting the writer slot when the caller lacks permission', async () => {
    await expect(recoverPublicFeedOperation(dependencies({ permissions: [] })))
      .resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(mocks.getBlockingOperation).not.toHaveBeenCalled();
  });
});

describe('transitionPublicFeedRollbackCapability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectPublicFeedHead.mockResolvedValue({
      head: rollbackHead({ rollbackEnabled: false }),
      artifact: TARGET,
      publicUrl: 'https://example.test/feed.json',
    });
    mocks.transitionRollbackCapability.mockResolvedValue({
      resultCode: 'CAPABILITY_UPDATED',
      eventId: 'event-id',
      createdAt: '2026-09-10T00:00:00.000Z',
      previousEnabled: false,
      rollbackEnabled: true,
      versionNumber: 2,
      generation: 2,
      feedHash: TARGET.feedHash,
      recordCount: TARGET.recordCount,
    });
  });

  it('binds the exact inspected Storage/head evidence and confirmation into the service-role RPC', async () => {
    const expected = {
      versionNumber: 2,
      generation: 2,
      feedHash: TARGET.feedHash,
      recordCount: TARGET.recordCount,
    };
    const confirmation = requiredPublicFeedRollbackCapabilityConfirmation(true, expected);

    await expect(transitionPublicFeedRollbackCapability(
      dependencies(), true, expected, confirmation,
    )).resolves.toMatchObject({ resultCode: 'CAPABILITY_UPDATED', rollbackEnabled: true });
    expect(mocks.transitionRollbackCapability).toHaveBeenCalledWith({
      adminId: ADMIN,
      enabled: true,
      requireExactHeadEvent: false,
      expectedVersionNumber: 2,
      expectedGeneration: 2,
      expectedFeedHash: TARGET.feedHash,
      expectedRecordCount: TARGET.recordCount,
      confirmation,
    });
  });

  it('refuses stale head evidence and mismatched typed confirmation before the RPC', async () => {
    const expected = {
      versionNumber: 2,
      generation: 2,
      feedHash: TARGET.feedHash,
      recordCount: TARGET.recordCount,
    };
    await expect(transitionPublicFeedRollbackCapability(
      dependencies(), true, { ...expected, generation: 1 },
      requiredPublicFeedRollbackCapabilityConfirmation(true, { ...expected, generation: 1 }),
    )).resolves.toEqual({ resultCode: 'STALE_HEAD' });
    await expect(transitionPublicFeedRollbackCapability(
      dependencies(), true, expected, 'ENABLE ROLLBACK',
    )).resolves.toEqual({ resultCode: 'CONFIRMATION_MISMATCH' });
    expect(mocks.transitionRollbackCapability).not.toHaveBeenCalled();
  });

  it('marks verified staging transitions as exact-head events inside the RPC', async () => {
    const expected = {
      versionNumber: 2,
      generation: 2,
      feedHash: TARGET.feedHash,
      recordCount: TARGET.recordCount,
    };
    const staging = dependencies({
      supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-a06-staging.supabase.co',
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    });

    await transitionPublicFeedRollbackCapability(
      staging, true, expected,
      requiredPublicFeedRollbackCapabilityConfirmation(true, expected),
    );

    expect(mocks.transitionRollbackCapability).toHaveBeenCalledWith(
      expect.objectContaining({ requireExactHeadEvent: true }),
    );
  });
});

describe('preparePublicFeedRollback staging authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isVerifiedStagingRollbackOperationAuthorized.mockResolvedValue(true);
    mocks.inspectPublicFeedHead.mockResolvedValue({
      head: rollbackHead(), artifact: TARGET, publicUrl: 'https://example.test/feed.json',
    });
    mocks.getVersionByNumber.mockResolvedValue(targetVersion());
    mocks.isCurrentVerifiedStagingRollbackCapabilityEnabled.mockResolvedValue(true);
    mocks.prepareVerifiedStagingRollback.mockResolvedValue({
      resultCode: 'PREPARED', preparationHandle: HANDLE,
    });
  });

  it('uses the exact-event-bound database preparation RPC for verified staging', async () => {
    const staging = dependencies({
      supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-a06-staging.supabase.co',
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
      listProjects: async () => [],
    });

    await expect(preparePublicFeedRollback(staging, 1))
      .resolves.toMatchObject({ resultCode: 'PREPARED' });
    expect(mocks.prepareVerifiedStagingRollback).toHaveBeenCalledWith(
      ADMIN, 1, TARGET.feedHash, TARGET.recordCount,
      { archivedPublicIds: [], changedPublicIds: [] },
    );
    expect(mocks.prepareRollback).not.toHaveBeenCalled();
  });

  it('rejects a raw head bit without an exact current staging capability event', async () => {
    mocks.isCurrentVerifiedStagingRollbackCapabilityEnabled.mockResolvedValue(false);
    const staging = dependencies({
      supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-a06-staging.supabase.co',
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    });

    await expect(preparePublicFeedRollback(staging, 1))
      .resolves.toEqual({ resultCode: 'ROLLBACK_UNAVAILABLE' });
    expect(mocks.prepareVerifiedStagingRollback).not.toHaveBeenCalled();
  });
});

describe('executePublicFeedRollback response-loss idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCurrentVerifiedStagingRollbackCapabilityEnabled.mockResolvedValue(true);
    mocks.isVerifiedStagingRollbackOperationAuthorized.mockResolvedValue(true);
    mocks.getHead.mockResolvedValue(rollbackHead());
    mocks.getVersionById.mockResolvedValue(targetVersion());
    mocks.getVersionByOperationId.mockResolvedValue(targetVersion({
      id: 'rollback-version', versionNumber: 2, operation: 'rollback',
      operationId: 'rollback-operation', previousVersionId: 'baseline-version',
      restoredFromVersionId: 'target-version',
    }));
    mocks.executePublicFeedWriter.mockResolvedValue({
      resultCode: 'COMPLETED', versionNumber: 2, feedHash: TARGET.feedHash,
      recordCount: TARGET.recordCount,
    });
  });

  it('resolves a consumed reservation to the exact active rollback operation', async () => {
    const operation = durableOperation('RESERVED', {
      id: 'rollback-operation', kind: 'rollback', publicationMode: null, publicId: null,
      rollbackPreparationId: HANDLE, candidateFeedContent: null,
    });
    mocks.getRollbackPreparation.mockResolvedValue(preparation({
      consumedAt: new Date().toISOString(), operationId: 'rollback-operation',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    mocks.getOperation.mockResolvedValue(operation);
    mocks.executePublicFeedWriter.mockResolvedValue({ resultCode: 'PUBLICATION_IN_PROGRESS' });

    await expect(executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({ resultCode: 'PUBLICATION_IN_PROGRESS' });
    expect(mocks.executePublicFeedWriter).toHaveBeenCalledWith(expect.objectContaining({
      recoveryOperationId: 'rollback-operation',
      rollbackPreparationHandle: HANDLE,
      rollbackAcknowledgement: ACKNOWLEDGEMENT,
    }));
  });

  it('resumes the exact bound candidate after a crash following binding', async () => {
    mocks.getRollbackPreparation.mockResolvedValue(preparation({
      consumedAt: new Date().toISOString(), operationId: 'rollback-operation',
    }));
    mocks.getOperation.mockResolvedValue(durableOperation('PREPARED', {
      id: 'rollback-operation', kind: 'rollback', publicationMode: null, publicId: null,
      rollbackPreparationId: HANDLE,
    }));

    await expect(executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({
        resultCode: 'COMPLETED', versionNumber: 2,
        feedHash: TARGET.feedHash, recordCount: TARGET.recordCount,
      });
    expect(mocks.executePublicFeedWriter).toHaveBeenCalledTimes(1);
  });

  it('returns the same immutable evidence on every completed retry without another writer call', async () => {
    mocks.getRollbackPreparation.mockResolvedValue(preparation({
      consumedAt: new Date().toISOString(), operationId: 'rollback-operation',
    }));
    mocks.getOperation.mockResolvedValue(durableOperation('COMPLETED', {
      id: 'rollback-operation', kind: 'rollback', publicationMode: null, publicId: null,
      rollbackPreparationId: HANDLE,
    }));

    const first = await executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT);
    const second = await executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT);

    expect(first).toEqual(second);
    expect(first).toEqual({
      resultCode: 'COMPLETED', versionNumber: 2,
      feedHash: TARGET.feedHash, recordCount: TARGET.recordCount,
    });
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
    expect(mocks.getVersionByOperationId).toHaveBeenCalledTimes(2);
  });

  it('returns completed evidence when the bound operation finishes during the retry race', async () => {
    mocks.getRollbackPreparation.mockResolvedValue(preparation({
      consumedAt: new Date().toISOString(), operationId: 'rollback-operation',
    }));
    mocks.getOperation
      .mockResolvedValueOnce(durableOperation('PREPARED', {
        id: 'rollback-operation', kind: 'rollback', publicationMode: null, publicId: null,
        rollbackPreparationId: HANDLE,
      }))
      .mockResolvedValueOnce(durableOperation('COMPLETED', {
        id: 'rollback-operation', kind: 'rollback', publicationMode: null, publicId: null,
        rollbackPreparationId: HANDLE,
      }));
    mocks.executePublicFeedWriter.mockResolvedValue({ resultCode: 'RECOVERY_REQUIRED' });

    await expect(executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({
        resultCode: 'COMPLETED', versionNumber: 2,
        feedHash: TARGET.feedHash, recordCount: TARGET.recordCount,
      });
    expect(mocks.getVersionByOperationId).toHaveBeenCalledWith('rollback-operation');
  });

  it('keeps missing handles, wrong actors, and wrong acknowledgement evidence stale', async () => {
    mocks.getRollbackPreparation.mockResolvedValueOnce(null);
    await expect(executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({ resultCode: 'STALE_PREPARATION' });

    mocks.getRollbackPreparation.mockResolvedValueOnce(preparation());
    await expect(executePublicFeedRollback(
      dependencies({ adminId: OTHER_ADMIN }), HANDLE, ACKNOWLEDGEMENT,
    )).resolves.toEqual({ resultCode: 'STALE_PREPARATION' });

    mocks.getRollbackPreparation.mockResolvedValueOnce(preparation());
    await expect(executePublicFeedRollback(dependencies(), HANDLE, 'WRONG ACKNOWLEDGEMENT'))
      .resolves.toEqual({ resultCode: 'STALE_PREPARATION' });
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });

  it('does not inspect a preparation or invoke the writer while the head capability is disabled', async () => {
    mocks.getHead.mockResolvedValue(rollbackHead({ rollbackEnabled: false }));

    await expect(executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({ resultCode: 'ROLLBACK_UNAVAILABLE' });
    expect(mocks.getRollbackPreparation).not.toHaveBeenCalled();
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });

  it('rejects staging execution when only the inherited raw head bit remains enabled', async () => {
    mocks.getRollbackPreparation.mockResolvedValue(preparation());
    mocks.isCurrentVerifiedStagingRollbackCapabilityEnabled.mockResolvedValue(false);
    const staging = dependencies({
      supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-a06-staging.supabase.co',
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    });

    await expect(executePublicFeedRollback(staging, HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({ resultCode: 'ROLLBACK_UNAVAILABLE' });
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });

  it('returns durable completed staging evidence after the exact-head capability expires', async () => {
    const operation = durableOperation('COMPLETED', {
      id: 'rollback-operation', kind: 'rollback', publicationMode: null, publicId: null,
      rollbackPreparationId: HANDLE,
    });
    mocks.getRollbackPreparation.mockResolvedValue(preparation({
      consumedAt: new Date().toISOString(), operationId: operation.id,
    }));
    mocks.getOperation.mockResolvedValue(operation);
    mocks.isVerifiedStagingRollbackOperationAuthorized.mockResolvedValue(true);
    const staging = dependencies({
      supabaseUrl: 'https://synthetic-a06-staging.supabase.co',
      environment: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'synthetic-a06-staging.supabase.co',
        CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED: 'true',
      },
    });

    await expect(executePublicFeedRollback(staging, HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({
        resultCode: 'COMPLETED', versionNumber: 2,
        feedHash: TARGET.feedHash, recordCount: TARGET.recordCount,
      });
    expect(mocks.isCurrentVerifiedStagingRollbackCapabilityEnabled).not.toHaveBeenCalled();
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });

  it('refuses a consumed preparation whose bound candidate contradicts the target version', async () => {
    mocks.getRollbackPreparation.mockResolvedValue(preparation({
      consumedAt: new Date().toISOString(), operationId: 'rollback-operation',
    }));
    mocks.getOperation.mockResolvedValue(durableOperation('PREPARED', {
      id: 'rollback-operation', kind: 'rollback', publicationMode: null, publicId: null,
      rollbackPreparationId: HANDLE, candidateFeedContent: '[{}]\n',
      candidateFeedHash: 'f'.repeat(64), candidateRecordCount: 1,
    }));

    await expect(executePublicFeedRollback(dependencies(), HANDLE, ACKNOWLEDGEMENT))
      .resolves.toEqual({ resultCode: 'STALE_PREPARATION' });
    expect(mocks.executePublicFeedWriter).not.toHaveBeenCalled();
  });
});
