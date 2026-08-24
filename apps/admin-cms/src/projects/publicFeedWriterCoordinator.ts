import { randomBytes, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createPublicFeedArtifact,
  verifyPublicFeedArtifact,
  type VerifiedPublicFeedArtifact,
} from '../feed/publicFeedArtifact';
import {
  SupabasePublicFeedLedgerRepositoryCore,
  type PublicFeedOperationKind,
  type PublicFeedOperationRecord,
  type PublicFeedPublicationMode,
} from '../repositories/SupabasePublicFeedLedgerRepositoryCore';
import { PublicFeedStorageBoundary } from '../storage/publicFeedStorage.private';
import type { PublicationMediaBinding } from './publicationArtifact';

const STORAGE_DEADLINE_MS = 45_000;

export type PublicFeedWriterResult =
  | {
      resultCode: 'COMPLETED' | 'ALREADY_COMPLETED';
      operationId: string;
      versionNumber: number | null;
      snapshotId: string | null;
      auditRecordId: string | null;
      feedHash: string;
      recordCount: number;
      feedPublicUrl: string;
    }
  | { resultCode: 'PERMISSION_DENIED' | 'PUBLICATION_IN_PROGRESS' | 'RECOVERY_REQUIRED' | 'HISTORY_NOT_ACTIVE' | 'ALREADY_ACTIVE' | 'STALE_PREPARATION' | 'NOT_READY' | 'NOT_PUBLISHED' | 'ALREADY_DEPLOYED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

export interface PreparedPublicFeedCandidate {
  artifact: VerifiedPublicFeedArtifact;
  mediaManifest?: PublicationMediaBinding[];
}

export interface PublicFeedWriterParameters {
  supabase: SupabaseClient;
  adminId: string;
  kind: PublicFeedOperationKind;
  publicationMode?: PublicFeedPublicationMode | null;
  publicId?: string | null;
  confirmedPreviewId?: string | null;
  confirmedAt?: string | null;
  privateBucket?: string | null;
  archiveReason?: string | null;
  rollbackPreparationHandle?: string | null;
  rollbackAcknowledgement?: string | null;
  feedBucket: string;
  feedPath: string;
  rollbackCapability?: boolean;
  /** Explicit operator authorization to claim one blocking RECOVERY_REQUIRED operation. */
  recoveryOperationId?: string;
  prepareCandidate(baseline: VerifiedPublicFeedArtifact | null): Promise<PreparedPublicFeedCandidate>;
  beforeCanonicalWrite?(manifest: PublicationMediaBinding[]): Promise<void>;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function safeFailure(error: unknown, fallback = 'EXECUTION_UNAVAILABLE'): string {
  if (!(error instanceof Error)) return fallback;
  const code = error.message;
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallback;
}

async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('PUBLIC_FEED_STORAGE_TIMEOUT')), STORAGE_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rpcCode(result: Record<string, unknown>): string {
  return typeof result.resultCode === 'string' ? result.resultCode : 'INVALID_RESPONSE';
}

function mapReservationFailure(code: string): PublicFeedWriterResult | null {
  if (code === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
  if (code === 'PUBLICATION_IN_PROGRESS' || code === 'UNCERTAINTY_FENCE_ACTIVE') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
  if (code === 'RECOVERY_REQUIRED' || code === 'LEGACY_RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
  if (code === 'HISTORY_NOT_ACTIVE') return { resultCode: 'HISTORY_NOT_ACTIVE' };
  if (code === 'ALREADY_ACTIVE') return { resultCode: 'ALREADY_ACTIVE' };
  if (code === 'STALE_PREPARATION') return { resultCode: 'STALE_PREPARATION' };
  if (code === 'NOT_READY') return { resultCode: 'NOT_READY' };
  if (code === 'NOT_PUBLISHED') return { resultCode: 'NOT_PUBLISHED' };
  if (code === 'ALREADY_DEPLOYED') return { resultCode: 'ALREADY_DEPLOYED' };
  return null;
}

async function verifyStorage(
  storage: PublicFeedStorageBoundary,
  bucket: string,
  path: string,
): Promise<VerifiedPublicFeedArtifact | null> {
  const bytes = await storage.readExact(bucket, path);
  return bytes ? verifyPublicFeedArtifact(bytes) : null;
}

function artifactFromOperation(operation: PublicFeedOperationRecord): VerifiedPublicFeedArtifact {
  if (operation.candidateFeedContent === null || operation.candidateFeedHash === null
      || operation.candidateRecordCount === null) {
    throw new Error('BOUND_ARTIFACT_UNAVAILABLE');
  }
  const artifact = verifyPublicFeedArtifact(operation.candidateFeedContent);
  if (artifact.feedHash !== operation.candidateFeedHash || artifact.recordCount !== operation.candidateRecordCount) {
    throw new Error('BOUND_ARTIFACT_INVALID');
  }
  return artifact;
}

function baselineFromOperation(operation: PublicFeedOperationRecord): VerifiedPublicFeedArtifact | null {
  if (!operation.baselineStorageExisted) return null;
  if (operation.baselineFeedContent === null || operation.baselineFeedHash === null
      || operation.baselineRecordCount === null) {
    throw new Error('BOUND_BASELINE_UNAVAILABLE');
  }
  const artifact = verifyPublicFeedArtifact(operation.baselineFeedContent);
  if (artifact.feedHash !== operation.baselineFeedHash || artifact.recordCount !== operation.baselineRecordCount) {
    throw new Error('BOUND_BASELINE_INVALID');
  }
  return artifact;
}

/**
 * The only coordinator allowed to mutate the canonical Storage object. Once WRITE_STARTED is
 * durable, every retry is the same immutable candidate and no baseline compensation is issued.
 */
export async function executePublicFeedWriter(params: PublicFeedWriterParameters): Promise<PublicFeedWriterResult> {
  const ledger = new SupabasePublicFeedLedgerRepositoryCore(params.supabase);
  const storage = new PublicFeedStorageBoundary(params.supabase);
  const ownerToken = token();
  let operation: PublicFeedOperationRecord | null = null;
  let epoch = 1;

  try {
    const blocking = await ledger.getBlockingOperation();
    if (blocking) {
      const sameIntent = blocking.kind === params.kind
        && blocking.publicId === (params.publicId ?? null)
        && blocking.rollbackPreparationId === (params.rollbackPreparationHandle ?? null);
      if (!sameIntent) {
        return { resultCode: blocking.state === 'RECOVERY_REQUIRED'
          ? 'RECOVERY_REQUIRED' : 'PUBLICATION_IN_PROGRESS' };
      }
      if (blocking.state === 'RECOVERY_REQUIRED'
          && params.recoveryOperationId !== blocking.id) {
        return { resultCode: 'RECOVERY_REQUIRED' };
      }
      if (Date.parse(blocking.leaseExpiresAt) > Date.now()) return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      const claim = await ledger.claim(blocking.id, params.adminId, ownerToken);
      const claimFailure = mapReservationFailure(rpcCode(claim));
      if (claimFailure) return claimFailure;
      if (claim.resultCode !== 'OPERATION_CLAIMED') {
        return { resultCode: 'EXECUTION_FAILED', failureCode: 'RECOVERY_CLAIM_FAILED' };
      }
      epoch = Number(claim.ownerEpoch);
      operation = await ledger.getOperation(blocking.id);
      if (!operation) throw new Error('RECOVERY_STATE_INVALID');
    } else {
      if (params.recoveryOperationId) return { resultCode: 'RECOVERY_REQUIRED' };
      const reservation = await ledger.reserve({
        operationKey: params.kind === 'rollback' ? null : randomUUID(),
        kind: params.kind, mode: params.publicationMode ?? null,
        adminId: params.adminId, publicId: params.publicId ?? null, ownerToken,
        confirmedPreviewId: params.confirmedPreviewId, confirmedAt: params.confirmedAt,
        privateBucket: params.privateBucket, archiveReason: params.archiveReason,
        rollbackPreparationHandle: params.rollbackPreparationHandle,
        rollbackAcknowledgement: params.rollbackAcknowledgement,
        storageBucket: params.feedBucket, storagePath: params.feedPath,
        rollbackCapability: params.rollbackCapability === true,
      });
      const reservationFailure = mapReservationFailure(rpcCode(reservation));
      if (reservationFailure) return reservationFailure;
      if (reservation.resultCode !== 'OPERATION_RESERVED') {
        return { resultCode: 'EXECUTION_FAILED', failureCode: 'RESERVATION_FAILED' };
      }
      const operationId = String(reservation.operationId || '');
      epoch = Number(reservation.ownerEpoch);
      operation = await ledger.getOperation(operationId);
      if (!operation) throw new Error('RESERVATION_STATE_INVALID');
    }

    let candidate: VerifiedPublicFeedArtifact;
    let baseline: VerifiedPublicFeedArtifact | null;
    let mediaManifest: PublicationMediaBinding[];

    if (operation.state === 'RESERVED') {
      const head = await ledger.getHead();
      const stored = await verifyStorage(storage, params.feedBucket, params.feedPath);
      if (params.kind === 'activation') {
        if (head) throw new Error('STALE_BASELINE');
        baseline = stored;
      } else {
        if (!head) return { resultCode: 'HISTORY_NOT_ACTIVE' };
        if (!stored || stored.content !== head.currentVersion.artifactContent
            || stored.feedHash !== head.currentVersion.feedHash
            || stored.recordCount !== head.currentVersion.recordCount) {
          await ledger.requireRecovery(
            operation.id,
            epoch,
            ownerToken,
            params.adminId,
            'STORAGE_HEAD_MISMATCH',
            stored?.feedHash ?? null,
            stored?.recordCount ?? null,
          );
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
        baseline = stored;
      }

      const prepared = await params.prepareCandidate(baseline);
      candidate = prepared.artifact;
      mediaManifest = prepared.mediaManifest ?? [];
      try {
        const bound = await ledger.bind({
          operationId: operation.id, epoch, token: ownerToken, actorId: params.adminId,
          baselineVersionId: head?.currentVersion.id ?? null,
          baselineStorageExisted: baseline !== null,
          baselineHash: baseline?.feedHash ?? null, baselineCount: baseline?.recordCount ?? null,
          baselineContent: baseline?.content ?? null, candidateHash: candidate.feedHash,
          candidateCount: candidate.recordCount, candidateContent: candidate.content,
          candidateMembers: candidate.members,
          feedPublicUrl: storage.getPublicUrl(params.feedBucket, params.feedPath), mediaManifest,
        });
        if (bound.resultCode !== 'ARTIFACT_BOUND') throw new Error('ARTIFACT_BINDING_REJECTED');
      } catch (error) {
        const reloaded = await ledger.getOperation(operation.id);
        if (!reloaded || reloaded.state !== 'PREPARED') throw error;
      }
      operation = await ledger.getOperation(operation.id);
      if (!operation) throw new Error('BOUND_STATE_INVALID');
    } else if (operation.state === 'RECOVERY_REQUIRED'
        && operation.candidateFeedContent === null) {
      return { resultCode: 'RECOVERY_REQUIRED' };
    } else {
      baseline = baselineFromOperation(operation);
      candidate = artifactFromOperation(operation);
      mediaManifest = operation.mediaManifest ?? [];
    }

    if (operation.state === 'RECOVERY_REQUIRED') {
      if (!params.recoveryOperationId || params.recoveryOperationId !== operation.id
          || operation.candidateFeedContent === null) {
        return { resultCode: 'RECOVERY_REQUIRED' };
      }
      const stored = await verifyStorage(storage, params.feedBucket, params.feedPath);
      if (stored?.content === candidate.content) {
        const observed = await ledger.observeCandidate(
          operation.id, epoch, ownerToken, params.adminId, candidate.feedHash, candidate.recordCount,
        );
        if (!['CANDIDATE_OBSERVED', 'DB_FINALIZED'].includes(rpcCode(observed))) {
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
      } else {
        const baselineMatches = baseline === null ? stored === null : stored?.content === baseline.content;
        if (!baselineMatches) return { resultCode: 'RECOVERY_REQUIRED' };
        const started = await ledger.markWriteStarted(operation.id, epoch, ownerToken, params.adminId);
        if (started.resultCode !== 'WRITE_STARTED') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
        try {
          await deadline(storage.writeExact(params.feedBucket, params.feedPath, candidate.bytes));
        } catch {
          return { resultCode: 'PUBLICATION_IN_PROGRESS' };
        }
        const observedBytes = await verifyStorage(storage, params.feedBucket, params.feedPath);
        if (!observedBytes || observedBytes.content !== candidate.content) {
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
        const observed = await ledger.observeCandidate(
          operation.id, epoch, ownerToken, params.adminId, candidate.feedHash, candidate.recordCount,
        );
        if (!['CANDIDATE_OBSERVED', 'DB_FINALIZED'].includes(rpcCode(observed))) {
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
      }
      operation = await ledger.getOperation(operation.id);
      if (!operation || !['CANDIDATE_OBSERVED', 'DB_FINALIZED'].includes(operation.state)) {
        return { resultCode: 'RECOVERY_REQUIRED' };
      }
    }

    if (operation.state === 'PREPARED') {
      await ledger.renew(operation.id, epoch, ownerToken, params.adminId);
      if (params.beforeCanonicalWrite) await params.beforeCanonicalWrite(mediaManifest);

      const currentStored = await verifyStorage(storage, params.feedBucket, params.feedPath);
      if (currentStored?.content === candidate.content) {
        try {
          const observed = await ledger.observeCandidate(
            operation.id, epoch, ownerToken, params.adminId, candidate.feedHash, candidate.recordCount,
          );
          if (observed.resultCode !== 'CANDIDATE_OBSERVED') throw new Error('CANDIDATE_OBSERVATION_REJECTED');
        } catch (error) {
          const reloaded = await ledger.getOperation(operation.id);
          if (!reloaded || reloaded.state !== 'CANDIDATE_OBSERVED') throw error;
        }
      } else {
        const baselineMatches = baseline === null ? currentStored === null : currentStored?.content === baseline.content;
        if (!baselineMatches) {
          await ledger.requireRecovery(operation.id, epoch, ownerToken, params.adminId, 'UNEXPECTED_STORAGE_STATE', currentStored?.feedHash ?? null, currentStored?.recordCount ?? null);
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
        let started: Record<string, unknown>;
        try {
          started = await ledger.markWriteStarted(operation.id, epoch, ownerToken, params.adminId);
        } catch (error) {
          const reloaded = await ledger.getOperation(operation.id);
          if (!reloaded || reloaded.state !== 'WRITE_STARTED') throw error;
          started = { resultCode: 'WRITE_STARTED' };
        }
        const startedFailure = mapReservationFailure(rpcCode(started));
        if (startedFailure) {
          if (startedFailure.resultCode === 'NOT_READY') {
            const failed = await ledger.fail(
              operation.id, epoch, ownerToken, params.adminId, startedFailure.resultCode,
            );
            if (failed.resultCode !== 'FAILED') return { resultCode: 'RECOVERY_REQUIRED' };
          }
          return startedFailure;
        }
        if (started.resultCode !== 'WRITE_STARTED') throw new Error('WRITE_INTENT_REJECTED');
        operation = { ...operation, state: 'WRITE_STARTED' };
        try {
          await deadline(storage.writeExact(params.feedBucket, params.feedPath, candidate.bytes));
        } catch {
          // The request may have committed. Durable WRITE_STARTED plus its uncertainty fence is
          // intentionally left authoritative for a later exact-read reconciliation.
          return { resultCode: 'PUBLICATION_IN_PROGRESS' };
        }
      }
      operation = await ledger.getOperation(operation.id);
      if (!operation) throw new Error('OPERATION_STATE_INVALID');
    }

    if (operation.state === 'WRITE_STARTED') {
      const stored = await verifyStorage(storage, params.feedBucket, params.feedPath);
      if (stored?.content === candidate.content) {
        try {
          const observed = await ledger.observeCandidate(operation.id, epoch, ownerToken, params.adminId, candidate.feedHash, candidate.recordCount);
          if (observed.resultCode !== 'CANDIDATE_OBSERVED') throw new Error('CANDIDATE_OBSERVATION_REJECTED');
        } catch (error) {
          const reloaded = await ledger.getOperation(operation.id);
          if (!reloaded || reloaded.state !== 'CANDIDATE_OBSERVED') throw error;
        }
      } else {
        const baselineMatches = baseline === null ? stored === null : stored?.content === baseline.content;
        if (!baselineMatches) {
          await ledger.requireRecovery(operation.id, epoch, ownerToken, params.adminId, 'UNEXPECTED_STORAGE_STATE', stored?.feedHash ?? null, stored?.recordCount ?? null);
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
        let started: Record<string, unknown>;
        try {
          started = await ledger.markWriteStarted(operation.id, epoch, ownerToken, params.adminId);
        } catch (error) {
          const reloaded = await ledger.getOperation(operation.id);
          if (!reloaded || reloaded.state !== 'WRITE_STARTED') throw error;
          started = { resultCode: 'WRITE_STARTED' };
        }
        if (started.resultCode !== 'WRITE_STARTED') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
        try {
          await deadline(storage.writeExact(params.feedBucket, params.feedPath, candidate.bytes));
        } catch {
          return { resultCode: 'PUBLICATION_IN_PROGRESS' };
        }
        const observedBytes = await verifyStorage(storage, params.feedBucket, params.feedPath);
        if (!observedBytes || observedBytes.content !== candidate.content) {
          await ledger.requireRecovery(operation.id, epoch, ownerToken, params.adminId, 'CANDIDATE_NOT_OBSERVED', observedBytes?.feedHash ?? null, observedBytes?.recordCount ?? null);
          return { resultCode: 'RECOVERY_REQUIRED' };
        }
        try {
          await ledger.observeCandidate(operation.id, epoch, ownerToken, params.adminId, candidate.feedHash, candidate.recordCount);
        } catch (error) {
          const reloaded = await ledger.getOperation(operation.id);
          if (!reloaded || reloaded.state !== 'CANDIDATE_OBSERVED') throw error;
        }
      }
      operation = await ledger.getOperation(operation.id);
      if (!operation) throw new Error('OPERATION_STATE_INVALID');
    }

    let finalization: Record<string, unknown> = {};
    if (operation.state === 'CANDIDATE_OBSERVED') {
      try {
        finalization = await ledger.finalize(operation.id, epoch, ownerToken, params.adminId);
      } catch {
        const reloaded = await ledger.getOperation(operation.id);
        if (!reloaded) throw new Error('FINALIZATION_FAILED');
        if (reloaded.state === 'CANDIDATE_OBSERVED') {
          finalization = await ledger.finalize(operation.id, epoch, ownerToken, params.adminId);
        } else if (reloaded.state === 'DB_FINALIZED') {
          finalization = await ledger.finalize(operation.id, epoch, ownerToken, params.adminId);
        } else {
          throw new Error('FINALIZATION_FAILED');
        }
      }
      if (finalization.resultCode !== undefined && finalization.resultCode !== 'DB_FINALIZED') {
        const reloaded = await ledger.getOperation(operation.id);
        if (!reloaded || reloaded.state !== 'DB_FINALIZED') throw new Error('FINALIZATION_FAILED');
      }
      operation = await ledger.getOperation(operation.id);
      if (!operation) throw new Error('OPERATION_STATE_INVALID');
    }

    if (operation.state === 'DB_FINALIZED') {
      const stored = await verifyStorage(storage, params.feedBucket, params.feedPath);
      if (!stored || stored.content !== candidate.content) {
        await ledger.requireRecovery(operation.id, epoch, ownerToken, params.adminId, 'POST_FINALIZATION_STORAGE_MISMATCH', stored?.feedHash ?? null, stored?.recordCount ?? null);
        return { resultCode: 'RECOVERY_REQUIRED' };
      }
      try {
        const completed = await ledger.complete(operation.id, epoch, ownerToken, params.adminId, candidate.feedHash, candidate.recordCount);
        if (completed.resultCode !== 'COMPLETED') throw new Error('COMPLETION_FAILED');
      } catch (error) {
        const reloaded = await ledger.getOperation(operation.id);
        if (!reloaded || reloaded.state !== 'COMPLETED') throw error;
      }
    } else if (operation.state !== 'COMPLETED') {
      throw new Error('OPERATION_STATE_INVALID');
    }

    const versionNumber = finalization.versionNumber === undefined || finalization.versionNumber === null
      ? null : Number(finalization.versionNumber);
    return {
      resultCode: operation.state === 'COMPLETED' ? 'ALREADY_COMPLETED' : 'COMPLETED',
      operationId: operation.id, versionNumber,
      snapshotId: finalization.snapshotId ? String(finalization.snapshotId) : null,
      auditRecordId: finalization.auditRecordId ? String(finalization.auditRecordId) : null,
      feedHash: candidate.feedHash, recordCount: candidate.recordCount,
      feedPublicUrl: storage.getPublicUrl(params.feedBucket, params.feedPath),
    };
  } catch (error) {
    if (operation && ['RESERVED', 'PREPARED'].includes(operation.state)) {
      const failureCode = safeFailure(error);
      try { await ledger.fail(operation.id, epoch, ownerToken, params.adminId, failureCode); } catch { /* bounded response below */ }
      return { resultCode: 'EXECUTION_FAILED', failureCode };
    }
    if (operation?.state === 'RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
    if (operation && ['WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED'].includes(operation.state)) {
      return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    }
    return { resultCode: 'EXECUTION_FAILED', failureCode: safeFailure(error) };
  }
}

export function emptyPublicFeedArtifact(): VerifiedPublicFeedArtifact {
  return createPublicFeedArtifact([]);
}

export async function inspectPublicFeedHead(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
): Promise<{ head: Awaited<ReturnType<SupabasePublicFeedLedgerRepositoryCore['getHead']>>; artifact: VerifiedPublicFeedArtifact | null; publicUrl: string }> {
  const ledger = new SupabasePublicFeedLedgerRepositoryCore(supabase);
  const storage = new PublicFeedStorageBoundary(supabase);
  const head = await ledger.getHead();
  const artifact = await verifyStorage(storage, bucket, path);
  if (head && (!artifact || artifact.content !== head.currentVersion.artifactContent
      || artifact.feedHash !== head.currentVersion.feedHash
      || artifact.recordCount !== head.currentVersion.recordCount)) {
    throw new Error('STORAGE_HEAD_MISMATCH');
  }
  return { head, artifact, publicUrl: storage.getPublicUrl(bucket, path) };
}
