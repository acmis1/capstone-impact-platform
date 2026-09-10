import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import type { AdminPermission } from '../auth/authTypes';
import { canPreparePublication } from '../auth/permissions';
import type { Project } from '../domain/project';
import { compilePublicFeed, toPublicFeedRecord } from '../feed/compilePublicFeed';
import { createPublicFeedArtifact, verifyPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { SupabasePublicFeedLedgerRepositoryCore } from '../repositories/SupabasePublicFeedLedgerRepositoryCore';
import { isLocalPublicFeedRollbackAvailable } from './localPublicationExecution';
import {
  assertPublicFeedRollbackEnvironmentAvailable,
  type PublicFeedRollbackExecutionTarget,
} from './publicFeedRollbackPolicy';
import type { PublicationMediaBinding } from './publicationArtifact';
import { executePublicFeedWriter, inspectPublicFeedHead } from './publicFeedWriterCoordinator';

export interface PublicFeedHistoryServiceDependencies {
  supabase: SupabaseClient;
  supabaseUrl: string;
  adminId: string;
  permissions: AdminPermission[];
  feedBucket: string;
  feedPath: string;
  listProjects(): Promise<Project[]>;
  assertActivationEnvironment(): void;
  environment?: Record<string, string | undefined>;
  /**
   * Forward completion of a durable operation's bound media manifest. Recovery of a publication
   * that crossed write intent cannot converge without it.
   */
  promoteBoundPublicMedia?(manifest: PublicationMediaBinding[]): Promise<void>;
}

function rollbackExecutionTarget(
  dependencies: PublicFeedHistoryServiceDependencies,
): PublicFeedRollbackExecutionTarget | null {
  try {
    return assertPublicFeedRollbackEnvironmentAvailable(
      dependencies.supabaseUrl,
      dependencies.environment,
    );
  } catch {
    return null;
  }
}

export type PublicFeedRecoveryResult =
  | { resultCode: 'COMPLETED'; versionNumber: number | null; feedHash: string; recordCount: number }
  | { resultCode: 'RELEASED' | 'PERMISSION_DENIED' | 'RECOVERY_REQUIRED' | 'PUBLICATION_IN_PROGRESS' | 'NO_RECOVERY_REQUIRED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

/** Explicit operator takeover for the one expired durable writer slot. */
export async function recoverPublicFeedOperation(
  dependencies: PublicFeedHistoryServiceDependencies,
): Promise<PublicFeedRecoveryResult> {
  if (!canPreparePublication(dependencies.permissions)) return { resultCode: 'PERMISSION_DENIED' };

  try {
    const ledger = new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase);
    const operation = await ledger.getBlockingOperation();
    if (!operation) return { resultCode: 'NO_RECOVERY_REQUIRED' };
    if (operation.kind === 'rollback') {
      const target = rollbackExecutionTarget(dependencies);
      if (!target) return { resultCode: 'RECOVERY_REQUIRED' };
      if (target === 'staging') {
        if (!await ledger.isVerifiedStagingRollbackOperationAuthorized(operation)) {
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
      } else {
        const head = await ledger.getHead();
        if (!head?.rollbackEnabled) return { resultCode: 'RECOVERY_REQUIRED' };
      }
    } else {
      try { dependencies.assertActivationEnvironment(); }
      catch { return { resultCode: 'EXECUTION_FAILED', failureCode: 'EXECUTION_POLICY_DENIED' }; }
    }
    if (operation.storageBucket !== dependencies.feedBucket
        || operation.storagePath !== dependencies.feedPath) {
      return { resultCode: 'RECOVERY_REQUIRED' };
    }

    // RESERVED has no bound candidate and no external side effect to converge. A current admin may
    // claim only after the lease expires, then close that exact fenced reservation so a fresh,
    // newly authorized request can build its own candidate.
    if (operation.state === 'RESERVED') {
      const ownerToken = randomBytes(32).toString('base64url');
      const claim = await ledger.claim(operation.id, dependencies.adminId, ownerToken);
      if (claim.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
      if (claim.resultCode === 'PUBLICATION_IN_PROGRESS'
          || claim.resultCode === 'UNCERTAINTY_FENCE_ACTIVE') {
        return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      }
      if (claim.resultCode !== 'OPERATION_CLAIMED') return { resultCode: 'RECOVERY_REQUIRED' };
      const claimed = await ledger.getOperation(operation.id);
      if (!claimed || claimed.state !== 'RESERVED') return { resultCode: 'RECOVERY_REQUIRED' };
      const failed = await ledger.fail(
        operation.id, Number(claim.ownerEpoch), ownerToken, dependencies.adminId,
        'ABANDONED_PRE_WRITE_OPERATION',
      );
      return failed.resultCode === 'FAILED'
        ? { resultCode: 'RELEASED' }
        : { resultCode: 'RECOVERY_REQUIRED' };
    }
    if (operation.candidateFeedContent === null) return { resultCode: 'RECOVERY_REQUIRED' };
    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId,
      kind: operation.kind, publicationMode: operation.publicationMode,
      publicId: operation.publicId, rollbackPreparationHandle: operation.rollbackPreparationId,
      // Recovery replays the durable operation's own immutable intent, so the coordinator's
      // intent equality holds by construction and nothing new can be smuggled in here.
      confirmedPreviewId: operation.confirmedPreviewId, confirmedAt: operation.confirmedAt,
      privateBucket: operation.privateMediaBucket, archiveReason: operation.archiveReason,
      rollbackCapability: operation.rollbackCapabilityRequested,
      feedBucket: dependencies.feedBucket, feedPath: dependencies.feedPath,
      recoveryOperationId: operation.id,
      prepareCandidate: async () => {
        throw new Error('RECOVERY_ARTIFACT_MUST_BE_DURABLE');
      },
      validateBeforeWriteIntent: operation.kind === 'activation'
        ? async () => {
            if (operation.candidateFeedContent === null) {
              throw new Error('BOUND_ARTIFACT_UNAVAILABLE');
            }
            const current = createPublicFeedArtifact(
              compilePublicFeed(await dependencies.listProjects()),
            );
            if (current.content !== operation.candidateFeedContent) {
              throw new Error('LIFECYCLE_STORAGE_MISMATCH');
            }
          }
        : operation.kind === 'rollback'
          ? async () => {
              const target = rollbackExecutionTarget(dependencies);
              if (!target) {
                throw new Error('ROLLBACK_UNAVAILABLE');
              }
              const currentHead = await ledger.getHead();
              if (!currentHead?.rollbackEnabled) throw new Error('ROLLBACK_UNAVAILABLE');
              if (target === 'staging'
                  && !await ledger.isVerifiedStagingRollbackOperationAuthorized(operation)) {
                throw new Error('ROLLBACK_UNAVAILABLE');
              }
              if (currentHead.currentVersion.id !== operation.baselineVersionId) {
                throw new Error('STALE_PREPARATION');
              }
            }
          : undefined,
      afterWriteIntent: dependencies.promoteBoundPublicMedia,
      verifiedStagingRollback: operation.kind === 'rollback'
        && rollbackExecutionTarget(dependencies) === 'staging',
    });
    if (writer.resultCode === 'COMPLETED' || writer.resultCode === 'ALREADY_COMPLETED') {
      return {
        resultCode: 'COMPLETED', versionNumber: writer.versionNumber,
        feedHash: writer.feedHash, recordCount: writer.recordCount,
      };
    }
    if (writer.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
    if (writer.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    if (writer.resultCode === 'RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
    return writer.resultCode === 'EXECUTION_FAILED'
      ? writer
      : { resultCode: 'EXECUTION_FAILED', failureCode: writer.resultCode };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'RECOVERY_EXECUTION_FAILED';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}

export type PublicFeedActivationResult =
  | { resultCode: 'COMPLETED' | 'ALREADY_ACTIVE'; versionNumber: number | null; feedHash: string; recordCount: number }
  | { resultCode: 'PERMISSION_DENIED' | 'PUBLICATION_IN_PROGRESS' | 'RECOVERY_REQUIRED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

export async function activatePublicFeedHistory(
  dependencies: PublicFeedHistoryServiceDependencies,
): Promise<PublicFeedActivationResult> {
  if (!canPreparePublication(dependencies.permissions)) return { resultCode: 'PERMISSION_DENIED' };
  try { dependencies.assertActivationEnvironment(); }
  catch { return { resultCode: 'EXECUTION_FAILED', failureCode: 'EXECUTION_POLICY_DENIED' }; }

  try {
    const existingHead = await new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase).getHead();
    if (existingHead) {
      const inspected = await inspectPublicFeedHead(
        dependencies.supabase, dependencies.feedBucket, dependencies.feedPath,
      );
      if (!inspected.artifact) throw new Error('PUBLIC_FEED_HEAD_CORRUPT');
      return {
        resultCode: 'ALREADY_ACTIVE', versionNumber: existingHead.currentVersion.versionNumber,
        feedHash: inspected.artifact.feedHash, recordCount: inspected.artifact.recordCount,
      };
    }
    const projects = await dependencies.listProjects();
    const projection = createPublicFeedArtifact(compilePublicFeed(projects));
    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId, kind: 'activation',
      feedBucket: dependencies.feedBucket, feedPath: dependencies.feedPath,
      rollbackCapability: isLocalPublicFeedRollbackAvailable(
        dependencies.supabaseUrl, dependencies.environment,
      ),
      legacyActivationTarget: projection,
      prepareCandidate: async (baseline) => {
        if (baseline && baseline.content !== projection.content) throw new Error('LIFECYCLE_STORAGE_MISMATCH');
        if (!baseline && projection.recordCount > 0) throw new Error('MISSING_NONEMPTY_BASELINE');
        return { artifact: projection };
      },
      validateBeforeWriteIntent: async () => {
        const current = createPublicFeedArtifact(
          compilePublicFeed(await dependencies.listProjects()),
        );
        if (current.content !== projection.content) throw new Error('LIFECYCLE_STORAGE_MISMATCH');
      },
    });
    if (writer.resultCode === 'COMPLETED' || writer.resultCode === 'ALREADY_COMPLETED') {
      return {
        resultCode: 'COMPLETED', versionNumber: writer.versionNumber,
        feedHash: writer.feedHash, recordCount: writer.recordCount,
      };
    }
    if (writer.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
    if (writer.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    if (writer.resultCode === 'RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
    if (writer.resultCode === 'ALREADY_ACTIVE') {
      const current = await inspectPublicFeedHead(
        dependencies.supabase, dependencies.feedBucket, dependencies.feedPath,
      );
      if (!current.head || !current.artifact) throw new Error('PUBLIC_FEED_HEAD_CORRUPT');
      return {
        resultCode: 'ALREADY_ACTIVE', versionNumber: current.head.currentVersion.versionNumber,
        feedHash: current.artifact.feedHash, recordCount: current.artifact.recordCount,
      };
    }
    return writer.resultCode === 'EXECUTION_FAILED'
      ? writer
      : { resultCode: 'EXECUTION_FAILED', failureCode: writer.resultCode };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'ACTIVATION_FAILED';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}

export type RollbackPreparationResult =
  | (Record<string, unknown> & {
      resultCode: 'PREPARED'; preparationHandle: string; targetVersionNumber: number;
      requiredAcknowledgement: string; expiresAt: string;
    })
  | { resultCode: 'PERMISSION_DENIED' | 'ROLLBACK_UNAVAILABLE' | 'VERSION_NOT_FOUND' | 'ALREADY_CURRENT' | 'ROLLBACK_TARGET_UNAVAILABLE' | 'PUBLICATION_IN_PROGRESS' | 'STALE_BASELINE' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

export interface PublicFeedRollbackHeadEvidence {
  versionNumber: number;
  generation: number;
  feedHash: string;
  recordCount: number;
}

export function requiredPublicFeedRollbackCapabilityConfirmation(
  enabled: boolean,
  evidence: PublicFeedRollbackHeadEvidence,
): string {
  return `${enabled ? 'ENABLE' : 'DISABLE'} PUBLIC FEED ROLLBACK FOR VERSION ${evidence.versionNumber}`
    + ` GENERATION ${evidence.generation} HASH ${evidence.feedHash} COUNT ${evidence.recordCount}`;
}

export type PublicFeedRollbackCapabilityResult =
  | (PublicFeedRollbackHeadEvidence & {
      resultCode: 'CAPABILITY_UPDATED';
      eventId: string;
      createdAt: string;
      previousEnabled: boolean;
      rollbackEnabled: boolean;
    })
  | (PublicFeedRollbackHeadEvidence & {
      resultCode: 'NO_CHANGE';
      rollbackEnabled: boolean;
    })
  | { resultCode: 'PERMISSION_DENIED' | 'ROLLBACK_UNAVAILABLE' | 'HISTORY_NOT_ACTIVE' | 'STALE_HEAD' | 'CONFIRMATION_MISMATCH' | 'PUBLICATION_IN_PROGRESS' | 'RECOVERY_REQUIRED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

/** Explicit operator transition; no startup path invokes this function. */
export async function transitionPublicFeedRollbackCapability(
  dependencies: PublicFeedHistoryServiceDependencies,
  enabled: boolean,
  expected: PublicFeedRollbackHeadEvidence,
  confirmation: string,
): Promise<PublicFeedRollbackCapabilityResult> {
  if (!canPreparePublication(dependencies.permissions)) return { resultCode: 'PERMISSION_DENIED' };
  const target = rollbackExecutionTarget(dependencies);
  if (!target) return { resultCode: 'ROLLBACK_UNAVAILABLE' };

  try {
    const inspected = await inspectPublicFeedHead(
      dependencies.supabase, dependencies.feedBucket, dependencies.feedPath,
    );
    if (!inspected.head || !inspected.artifact) return { resultCode: 'HISTORY_NOT_ACTIVE' };
    const actual: PublicFeedRollbackHeadEvidence = {
      versionNumber: inspected.head.currentVersion.versionNumber,
      generation: inspected.head.generation,
      feedHash: inspected.artifact.feedHash,
      recordCount: inspected.artifact.recordCount,
    };
    if (actual.versionNumber !== expected.versionNumber
        || actual.generation !== expected.generation
        || actual.feedHash !== expected.feedHash
        || actual.recordCount !== expected.recordCount) {
      return { resultCode: 'STALE_HEAD' };
    }
    if (confirmation !== requiredPublicFeedRollbackCapabilityConfirmation(enabled, actual)) {
      return { resultCode: 'CONFIRMATION_MISMATCH' };
    }
    return await new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase)
      .transitionRollbackCapability({
        adminId: dependencies.adminId,
        enabled,
        requireExactHeadEvent: target === 'staging',
        expectedVersionNumber: actual.versionNumber,
        expectedGeneration: actual.generation,
        expectedFeedHash: actual.feedHash,
        expectedRecordCount: actual.recordCount,
        confirmation,
      }) as PublicFeedRollbackCapabilityResult;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'ROLLBACK_CAPABILITY_TRANSITION_FAILED';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}

export async function preparePublicFeedRollback(
  dependencies: PublicFeedHistoryServiceDependencies,
  targetVersionNumber: number,
): Promise<RollbackPreparationResult> {
  if (!canPreparePublication(dependencies.permissions)) return { resultCode: 'PERMISSION_DENIED' };
  const executionTarget = rollbackExecutionTarget(dependencies);
  if (!executionTarget) return { resultCode: 'ROLLBACK_UNAVAILABLE' };
  if (!Number.isSafeInteger(targetVersionNumber) || targetVersionNumber <= 0) {
    return { resultCode: 'VERSION_NOT_FOUND' };
  }
  try {
    const ledger = new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase);
    const inspected = await inspectPublicFeedHead(
      dependencies.supabase, dependencies.feedBucket, dependencies.feedPath,
    );
    if (!inspected.head || !inspected.artifact) throw new Error('HISTORY_NOT_ACTIVE');
    const rollbackEnabled = executionTarget === 'staging'
      ? await ledger.isCurrentVerifiedStagingRollbackCapabilityEnabled()
      : inspected.head.rollbackEnabled;
    if (!rollbackEnabled) return { resultCode: 'ROLLBACK_UNAVAILABLE' };
    const targetVersion = await ledger.getVersionByNumber(targetVersionNumber);
    if (!targetVersion) return { resultCode: 'VERSION_NOT_FOUND' };
    const target = verifyPublicFeedArtifact(targetVersion.artifactContent);
    if (target.feedHash !== targetVersion.feedHash || target.recordCount !== targetVersion.recordCount) {
      throw new Error('HISTORICAL_ARTIFACT_CORRUPT');
    }

    const projects = await dependencies.listProjects();
    const byPublicId = new Map(projects.filter((project) => project.publicId).map((project) => [project.publicId, project]));
    const missingPublicIds: string[] = [];
    const archivedPublicIds: string[] = [];
    const changedPublicIds: string[] = [];
    for (const targetRecord of target.feed) {
      const currentProject = byPublicId.get(targetRecord.publicId);
      if (!currentProject) {
        missingPublicIds.push(targetRecord.publicId);
        continue;
      }
      if (currentProject.status === 'archived') archivedPublicIds.push(targetRecord.publicId);
      const currentRecord = toPublicFeedRecord(currentProject);
      if (JSON.stringify(currentRecord) !== JSON.stringify(targetRecord)) changedPublicIds.push(targetRecord.publicId);
    }
    if (missingPublicIds.length > 0) return { resultCode: 'ROLLBACK_TARGET_UNAVAILABLE' };
    const prepare = executionTarget === 'staging'
      ? ledger.prepareVerifiedStagingRollback.bind(ledger)
      : ledger.prepareRollback.bind(ledger);
    const result = await prepare(
      dependencies.adminId, targetVersionNumber, inspected.artifact.feedHash,
      inspected.artifact.recordCount, { archivedPublicIds, changedPublicIds },
    );
    return result as RollbackPreparationResult;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'ROLLBACK_PREPARATION_FAILED';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}

export type PublicFeedRollbackResult =
  | { resultCode: 'COMPLETED'; versionNumber: number | null; feedHash: string; recordCount: number }
  | { resultCode: 'PERMISSION_DENIED' | 'ROLLBACK_UNAVAILABLE' | 'STALE_PREPARATION' | 'PUBLICATION_IN_PROGRESS' | 'RECOVERY_REQUIRED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

export async function executePublicFeedRollback(
  dependencies: PublicFeedHistoryServiceDependencies,
  preparationHandle: string,
  acknowledgement: string,
): Promise<PublicFeedRollbackResult> {
  if (!canPreparePublication(dependencies.permissions)) return { resultCode: 'PERMISSION_DENIED' };
  const executionTarget = rollbackExecutionTarget(dependencies);
  if (!executionTarget) return { resultCode: 'ROLLBACK_UNAVAILABLE' };
  try {
    const ledger = new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase);
    if (executionTarget === 'local') {
      const head = await ledger.getHead();
      if (!head?.rollbackEnabled) return { resultCode: 'ROLLBACK_UNAVAILABLE' };
    }
    const preparation = await ledger.getRollbackPreparation(preparationHandle);
    const acknowledgementDigest = createHash('sha256').update(acknowledgement, 'utf8').digest('hex');
    if (!preparation || preparation.actorId !== dependencies.adminId
        || preparation.acknowledgementDigest !== acknowledgementDigest) {
      return { resultCode: 'STALE_PREPARATION' };
    }
    const consumed = preparation.consumedAt !== null;
    if (!consumed && Date.parse(preparation.expiresAt) <= Date.now()) {
      return { resultCode: 'STALE_PREPARATION' };
    }

    const boundOperation = consumed && preparation.operationId
      ? await ledger.getOperation(preparation.operationId)
      : null;
    if (consumed && (!preparation.operationId || !boundOperation
        || boundOperation.id !== preparation.operationId
        || boundOperation.kind !== 'rollback'
        || boundOperation.authorizingActorId !== preparation.actorId
        || boundOperation.rollbackPreparationId !== preparation.handle
        || boundOperation.storageBucket !== dependencies.feedBucket
        || boundOperation.storagePath !== dependencies.feedPath
        || (!['RESERVED', 'FAILED'].includes(boundOperation.state)
          && boundOperation.baselineVersionId !== preparation.baselineVersionId))) {
      return { resultCode: 'STALE_PREPARATION' };
    }
    if (boundOperation?.state === 'FAILED') return { resultCode: 'STALE_PREPARATION' };

    const targetVersion = await ledger.getVersionById(preparation.targetVersionId);
    if (!targetVersion) return { resultCode: 'STALE_PREPARATION' };
    const target = verifyPublicFeedArtifact(targetVersion.artifactContent);
    if (target.feedHash !== targetVersion.feedHash || target.recordCount !== targetVersion.recordCount) {
      throw new Error('HISTORICAL_ARTIFACT_CORRUPT');
    }
    if (boundOperation?.candidateFeedContent !== null
        && boundOperation?.candidateFeedContent !== undefined
        && (boundOperation.candidateFeedContent !== target.content
          || boundOperation.candidateFeedHash !== target.feedHash
          || boundOperation.candidateRecordCount !== target.recordCount)) {
      return { resultCode: 'STALE_PREPARATION' };
    }
    const completedEvidence = async (operationId: string): Promise<PublicFeedRollbackResult> => {
      const completedVersion = await ledger.getVersionByOperationId(operationId);
      if (!completedVersion
          || completedVersion.operation !== 'rollback'
          || completedVersion.restoredFromVersionId !== preparation.targetVersionId
          || completedVersion.artifactContent !== target.content
          || completedVersion.feedHash !== target.feedHash
          || completedVersion.recordCount !== target.recordCount) {
        throw new Error('ROLLBACK_COMPLETION_EVIDENCE_INVALID');
      }
      return {
        resultCode: 'COMPLETED', versionNumber: completedVersion.versionNumber,
        feedHash: completedVersion.feedHash, recordCount: completedVersion.recordCount,
      };
    };
    if (executionTarget === 'staging') {
      const stagingCapabilityValid = boundOperation
        ? await ledger.isVerifiedStagingRollbackOperationAuthorized(boundOperation)
        : await ledger.isCurrentVerifiedStagingRollbackCapabilityEnabled();
      if (!stagingCapabilityValid) return { resultCode: 'ROLLBACK_UNAVAILABLE' };
    }
    if (boundOperation?.state === 'COMPLETED') return completedEvidence(boundOperation.id);
    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId, kind: 'rollback',
      rollbackPreparationHandle: preparationHandle, rollbackAcknowledgement: acknowledgement,
      feedBucket: dependencies.feedBucket, feedPath: dependencies.feedPath,
      verifiedStagingRollback: executionTarget === 'staging',
      recoveryOperationId: boundOperation?.id,
      prepareCandidate: async () => ({ artifact: target }),
      validateBeforeWriteIntent: async () => {
        if (!rollbackExecutionTarget(dependencies)) {
          throw new Error('ROLLBACK_UNAVAILABLE');
        }
        const currentHead = await ledger.getHead();
        if (!currentHead?.rollbackEnabled) throw new Error('ROLLBACK_UNAVAILABLE');
        if (executionTarget === 'staging') {
          const stagingCapabilityValid = boundOperation
            ? await ledger.isVerifiedStagingRollbackOperationAuthorized(boundOperation)
            : await ledger.isCurrentVerifiedStagingRollbackCapabilityEnabled();
          if (!stagingCapabilityValid) throw new Error('ROLLBACK_UNAVAILABLE');
        }
        if (currentHead.currentVersion.id !== preparation.baselineVersionId) {
          throw new Error('STALE_PREPARATION');
        }
      },
    });
    if (writer.resultCode === 'COMPLETED' || writer.resultCode === 'ALREADY_COMPLETED') {
      return {
        resultCode: 'COMPLETED', versionNumber: writer.versionNumber,
        feedHash: writer.feedHash, recordCount: writer.recordCount,
      };
    }
    if (boundOperation) {
      const reloaded = await ledger.getOperation(boundOperation.id);
      if (reloaded?.state === 'COMPLETED') return completedEvidence(boundOperation.id);
    }
    if (writer.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
    if (writer.resultCode === 'ROLLBACK_UNAVAILABLE') return { resultCode: 'ROLLBACK_UNAVAILABLE' };
    if (writer.resultCode === 'STALE_PREPARATION') return { resultCode: 'STALE_PREPARATION' };
    if (writer.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    if (writer.resultCode === 'RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
    if (writer.resultCode === 'EXECUTION_FAILED'
        && writer.failureCode === 'ROLLBACK_UNAVAILABLE') {
      return { resultCode: 'ROLLBACK_UNAVAILABLE' };
    }
    if (writer.resultCode === 'EXECUTION_FAILED'
        && writer.failureCode === 'STALE_PREPARATION') {
      return { resultCode: 'STALE_PREPARATION' };
    }
    return writer.resultCode === 'EXECUTION_FAILED'
      ? writer
      : { resultCode: 'EXECUTION_FAILED', failureCode: writer.resultCode };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'ROLLBACK_EXECUTION_FAILED';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}
