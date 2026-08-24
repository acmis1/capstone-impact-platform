import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminPermission } from '../auth/authTypes';
import { canPreparePublication } from '../auth/permissions';
import type { Project } from '../domain/project';
import { compilePublicFeed, toPublicFeedRecord } from '../feed/compilePublicFeed';
import { createPublicFeedArtifact, verifyPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { SupabasePublicFeedLedgerRepositoryCore } from '../repositories/SupabasePublicFeedLedgerRepositoryCore';
import { isLocalPublicFeedRollbackAvailable } from './localPublicationExecution';
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
}

export type PublicFeedRecoveryResult =
  | { resultCode: 'COMPLETED'; versionNumber: number | null; feedHash: string; recordCount: number }
  | { resultCode: 'PERMISSION_DENIED' | 'RECOVERY_REQUIRED' | 'PUBLICATION_IN_PROGRESS' | 'NO_RECOVERY_REQUIRED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

/** Explicit operator retry for the one durable RECOVERY_REQUIRED slot. */
export async function recoverPublicFeedOperation(
  dependencies: PublicFeedHistoryServiceDependencies,
): Promise<PublicFeedRecoveryResult> {
  if (!canPreparePublication(dependencies.permissions)) return { resultCode: 'PERMISSION_DENIED' };
  try { dependencies.assertActivationEnvironment(); }
  catch { return { resultCode: 'EXECUTION_FAILED', failureCode: 'EXECUTION_POLICY_DENIED' }; }

  try {
    const ledger = new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase);
    const operation = await ledger.getBlockingOperation();
    if (!operation || operation.state !== 'RECOVERY_REQUIRED') {
      return { resultCode: 'NO_RECOVERY_REQUIRED' };
    }
    if (operation.kind === 'rollback' && !isLocalPublicFeedRollbackAvailable(
      dependencies.supabaseUrl, dependencies.environment,
    )) {
      return { resultCode: 'RECOVERY_REQUIRED' };
    }
    if (operation.storageBucket !== dependencies.feedBucket
        || operation.storagePath !== dependencies.feedPath
        || operation.candidateFeedContent === null) {
      return { resultCode: 'RECOVERY_REQUIRED' };
    }
    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId,
      kind: operation.kind, publicationMode: operation.publicationMode,
      publicId: operation.publicId, rollbackPreparationHandle: operation.rollbackPreparationId,
      feedBucket: dependencies.feedBucket, feedPath: dependencies.feedPath,
      recoveryOperationId: operation.id,
      prepareCandidate: async () => {
        throw new Error('RECOVERY_ARTIFACT_MUST_BE_DURABLE');
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
    const inspected = await inspectPublicFeedHead(
      dependencies.supabase, dependencies.feedBucket, dependencies.feedPath,
    );
    if (inspected.head && inspected.artifact) {
      return {
        resultCode: 'ALREADY_ACTIVE', versionNumber: inspected.head.currentVersion.versionNumber,
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
      prepareCandidate: async (baseline) => {
        if (baseline && baseline.content !== projection.content) throw new Error('LIFECYCLE_STORAGE_MISMATCH');
        if (!baseline && projection.recordCount > 0) throw new Error('MISSING_NONEMPTY_BASELINE');
        return { artifact: projection };
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

export async function preparePublicFeedRollback(
  dependencies: PublicFeedHistoryServiceDependencies,
  targetVersionNumber: number,
): Promise<RollbackPreparationResult> {
  if (!canPreparePublication(dependencies.permissions)) return { resultCode: 'PERMISSION_DENIED' };
  if (!isLocalPublicFeedRollbackAvailable(
    dependencies.supabaseUrl, dependencies.environment,
  )) return { resultCode: 'ROLLBACK_UNAVAILABLE' };
  if (!Number.isSafeInteger(targetVersionNumber) || targetVersionNumber <= 0) {
    return { resultCode: 'VERSION_NOT_FOUND' };
  }
  try {
    const ledger = new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase);
    const inspected = await inspectPublicFeedHead(
      dependencies.supabase, dependencies.feedBucket, dependencies.feedPath,
    );
    if (!inspected.head || !inspected.artifact) throw new Error('HISTORY_NOT_ACTIVE');
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
    const result = await ledger.prepareRollback(
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
  if (!isLocalPublicFeedRollbackAvailable(
    dependencies.supabaseUrl, dependencies.environment,
  )) return { resultCode: 'ROLLBACK_UNAVAILABLE' };
  try {
    const ledger = new SupabasePublicFeedLedgerRepositoryCore(dependencies.supabase);
    const preparation = await ledger.getRollbackPreparation(preparationHandle);
    if (!preparation || preparation.actorId !== dependencies.adminId
        || preparation.consumedAt !== null || Date.parse(preparation.expiresAt) <= Date.now()) {
      return { resultCode: 'STALE_PREPARATION' };
    }
    const targetVersion = await ledger.getVersionById(preparation.targetVersionId);
    if (!targetVersion) return { resultCode: 'STALE_PREPARATION' };
    const target = verifyPublicFeedArtifact(targetVersion.artifactContent);
    if (target.feedHash !== targetVersion.feedHash || target.recordCount !== targetVersion.recordCount) {
      throw new Error('HISTORICAL_ARTIFACT_CORRUPT');
    }
    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId, kind: 'rollback',
      rollbackPreparationHandle: preparationHandle, rollbackAcknowledgement: acknowledgement,
      feedBucket: dependencies.feedBucket, feedPath: dependencies.feedPath,
      prepareCandidate: async () => ({ artifact: target }),
    });
    if (writer.resultCode === 'COMPLETED' || writer.resultCode === 'ALREADY_COMPLETED') {
      return {
        resultCode: 'COMPLETED', versionNumber: writer.versionNumber,
        feedHash: writer.feedHash, recordCount: writer.recordCount,
      };
    }
    if (writer.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
    if (writer.resultCode === 'STALE_PREPARATION') return { resultCode: 'STALE_PREPARATION' };
    if (writer.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    if (writer.resultCode === 'RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
    return writer.resultCode === 'EXECUTION_FAILED'
      ? writer
      : { resultCode: 'EXECUTION_FAILED', failureCode: writer.resultCode };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'ROLLBACK_EXECUTION_FAILED';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}
