import { randomBytes, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createPublicFeedArtifact,
  PublicFeedArtifactError,
  verifyPublicFeedArtifact,
  type VerifiedPublicFeedArtifact,
} from '../feed/publicFeedArtifact';
import {
  verifyLegacyPublicFeedBaseline,
} from '../feed/legacyPublicFeedBaseline';
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
  /**
   * Exact current-contract lifecycle projection that may upgrade the sole supported pre-gallery
   * baseline shape. Honored only for a fresh activation with no ledger head; never browser-derived.
   */
  legacyActivationTarget?: VerifiedPublicFeedArtifact;
  /** Explicit operator authorization to claim one blocking RECOVERY_REQUIRED operation. */
  recoveryOperationId?: string;
  prepareCandidate(baseline: VerifiedPublicFeedArtifact | null): Promise<PreparedPublicFeedCandidate>;
  /**
   * Read-only re-validation of the bound media manifest. Invoked immediately before write intent,
   * while failure is still free: throwing here fails the operation with zero external side effects.
   */
  validateBeforeWriteIntent?(manifest: PublicationMediaBinding[]): Promise<void>;
  /**
   * The only hook permitted to create externally visible side effects. Invoked only once
   * WRITE_STARTED is durable, so everything it does is already described by the immutable manifest
   * and can be replayed forward by any later recovery owner. It must be idempotent.
   */
  afterWriteIntent?(manifest: PublicationMediaBinding[]): Promise<void>;
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

type ObservedPublicFeedBaseline = Pick<
  VerifiedPublicFeedArtifact,
  'content' | 'bytes' | 'feedHash' | 'recordCount'
>;

interface ActivationStorageBaseline {
  observed: ObservedPublicFeedBaseline;
  current: VerifiedPublicFeedArtifact;
}

async function verifyActivationStorageBaseline(
  storage: PublicFeedStorageBoundary,
  bucket: string,
  path: string,
  legacyTarget: VerifiedPublicFeedArtifact | undefined,
): Promise<ActivationStorageBaseline | null> {
  const bytes = await storage.readExact(bucket, path);
  if (!bytes) return null;
  try {
    const artifact = verifyPublicFeedArtifact(bytes);
    return { observed: artifact, current: artifact };
  } catch (error) {
    if (!legacyTarget || !(error instanceof PublicFeedArtifactError)
        || error.code !== 'ARTIFACT_CONTRACT_INVALID') {
      throw error;
    }
    const legacy = verifyLegacyPublicFeedBaseline(bytes, legacyTarget);
    return { observed: legacy, current: legacy.upgradedArtifact };
  }
}

async function observeOperationStorage(
  storage: PublicFeedStorageBoundary,
  bucket: string,
  path: string,
  baseline: ObservedPublicFeedBaseline | null,
): Promise<ObservedPublicFeedBaseline | null> {
  const bytes = await storage.readExact(bucket, path);
  if (!bytes) return null;
  if (baseline && bytes.compare(baseline.bytes) === 0) return baseline;
  return verifyPublicFeedArtifact(bytes);
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

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function sameInstant(durable: string | null, requested: string | null | undefined): boolean {
  const incoming = requested ?? null;
  if (durable === null || incoming === null) return durable === incoming;
  const left = Date.parse(durable);
  const right = Date.parse(incoming);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * Complete immutable-intent equality, evaluated before any claim or reuse of a durable operation.
 *
 * Comparing only kind/publicId/rollback handle is not enough: a normal publication and a
 * deployment reconciliation, two archives with different reasons, or two requests carrying
 * different participant confirmation evidence are materially different authorizations. Allowing
 * any of them to adopt another's durable operation would either reuse a candidate bound under
 * different authority or bind a fresh candidate under stale durable metadata.
 *
 * `explicitRecovery` relaxes only the authorizing-actor check, so a second administrator may drive
 * the operator recovery path for an operation another administrator authorized; every semantic
 * field still has to match exactly.
 */
function bindsSameIntent(
  blocking: PublicFeedOperationRecord,
  params: PublicFeedWriterParameters,
  explicitRecovery: boolean,
): boolean {
  const semanticMatch = blocking.kind === params.kind
    && blocking.publicationMode === (params.publicationMode ?? null)
    && blocking.publicId === (params.publicId ?? null)
    && blocking.rollbackPreparationId === (params.rollbackPreparationHandle ?? null)
    && blocking.confirmedPreviewId === (params.confirmedPreviewId ?? null)
    && sameInstant(blocking.confirmedAt, params.confirmedAt)
    && blocking.privateMediaBucket === trimmedOrNull(params.privateBucket)
    && blocking.archiveReason === trimmedOrNull(params.archiveReason)
    && blocking.rollbackCapabilityRequested === (params.kind === 'activation' && params.rollbackCapability === true)
    && blocking.storageBucket === params.feedBucket
    && blocking.storagePath === params.feedPath;
  return explicitRecovery ? semanticMatch : semanticMatch && blocking.authorizingActorId === params.adminId;
}

function baselineFromOperation(
  operation: PublicFeedOperationRecord,
  candidate: VerifiedPublicFeedArtifact,
): ObservedPublicFeedBaseline | null {
  if (!operation.baselineStorageExisted) return null;
  if (operation.baselineFeedContent === null || operation.baselineFeedHash === null
      || operation.baselineRecordCount === null) {
    throw new Error('BOUND_BASELINE_UNAVAILABLE');
  }
  let artifact: ObservedPublicFeedBaseline;
  try {
    artifact = verifyPublicFeedArtifact(operation.baselineFeedContent);
  } catch (error) {
    if (operation.kind !== 'activation' || !(error instanceof PublicFeedArtifactError)
        || error.code !== 'ARTIFACT_CONTRACT_INVALID') {
      throw error;
    }
    artifact = verifyLegacyPublicFeedBaseline(operation.baselineFeedContent, candidate);
  }
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
  let mediaPromoted = false;

  /**
   * Runs strictly after WRITE_STARTED is durable. A failure here may have already exposed part of
   * the manifest, so the operation is parked in RECOVERY_REQUIRED — which durably describes every
   * object the manifest permits — instead of deleting anything back out.
   */
  const promoteMedia = async (
    operationId: string,
    manifest: PublicationMediaBinding[],
  ): Promise<PublicFeedWriterResult | null> => {
    if (mediaPromoted || manifest.length === 0 || !params.afterWriteIntent) return null;
    try {
      await params.afterWriteIntent(manifest);
      mediaPromoted = true;
      return null;
    } catch (error) {
      await ledger.requireRecovery(
        operationId, epoch, ownerToken, params.adminId,
        safeFailure(error, 'PUBLIC_MEDIA_PROMOTION_FAILED'), null, null,
      );
      return { resultCode: 'RECOVERY_REQUIRED' };
    }
  };

  try {
    if (params.legacyActivationTarget && params.kind !== 'activation') {
      throw new Error('LEGACY_BASELINE_SCOPE_INVALID');
    }
    const blocking = await ledger.getBlockingOperation();
    if (blocking) {
      const explicitRecovery = params.recoveryOperationId === blocking.id;
      if (blocking.state === 'RECOVERY_REQUIRED' && !explicitRecovery) {
        return { resultCode: 'RECOVERY_REQUIRED' };
      }
      if (!bindsSameIntent(blocking, params, explicitRecovery)) {
        return { resultCode: blocking.state === 'RECOVERY_REQUIRED'
          ? 'RECOVERY_REQUIRED' : 'PUBLICATION_IN_PROGRESS' };
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
    let baseline: ObservedPublicFeedBaseline | null;
    let mediaManifest: PublicationMediaBinding[];

    if (operation.state === 'RESERVED') {
      const head = await ledger.getHead();
      let candidateBaseline: VerifiedPublicFeedArtifact | null;
      if (params.kind === 'activation') {
        if (head) throw new Error('STALE_BASELINE');
        const stored = await verifyActivationStorageBaseline(
          storage, params.feedBucket, params.feedPath, params.legacyActivationTarget,
        );
        baseline = stored?.observed ?? null;
        candidateBaseline = stored?.current ?? null;
      } else {
        const stored = await verifyStorage(storage, params.feedBucket, params.feedPath);
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
        candidateBaseline = stored;
      }

      const prepared = await params.prepareCandidate(candidateBaseline);
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
      candidate = artifactFromOperation(operation);
      baseline = baselineFromOperation(operation, candidate);
      mediaManifest = operation.mediaManifest ?? [];
    }

    if (params.legacyActivationTarget && operation.state === 'PREPARED'
        && candidate.content !== params.legacyActivationTarget.content) {
      throw new Error('LEGACY_UPGRADE_TARGET_MISMATCH');
    }

    // A bound manifest is part of the operation's durable intent. Refusing to advance without a
    // promotion capability keeps a recovery owner from writing a canonical feed whose public media
    // URLs were never made readable.
    if (mediaManifest.length > 0 && !params.afterWriteIntent) {
      throw new Error('MEDIA_PROMOTION_UNAVAILABLE');
    }

    if (operation.state === 'RECOVERY_REQUIRED') {
      if (!params.recoveryOperationId || params.recoveryOperationId !== operation.id
          || operation.candidateFeedContent === null) {
        return { resultCode: 'RECOVERY_REQUIRED' };
      }
      const stored = await observeOperationStorage(
        storage, params.feedBucket, params.feedPath, baseline,
      );
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
        const promotionFailure = await promoteMedia(operation.id, mediaManifest);
        if (promotionFailure) return promotionFailure;
        try {
          await deadline(storage.writeExact(params.feedBucket, params.feedPath, candidate.bytes));
        } catch {
          return { resultCode: 'PUBLICATION_IN_PROGRESS' };
        }
        const observedBytes = await observeOperationStorage(
          storage, params.feedBucket, params.feedPath, baseline,
        );
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
      // Ownership is confirmed before anything external is attempted. A worker that lost its lease
      // to a later claim must produce zero external side effects.
      const renewal = await ledger.renew(operation.id, epoch, ownerToken, params.adminId);
      if (rpcCode(renewal) !== 'LEASE_RENEWED') {
        return rpcCode(renewal) === 'STALE_OWNER'
          ? { resultCode: 'PUBLICATION_IN_PROGRESS' }
          : { resultCode: 'EXECUTION_FAILED', failureCode: 'LEASE_RENEWAL_REJECTED' };
      }

      const currentStored = await observeOperationStorage(
        storage, params.feedBucket, params.feedPath, baseline,
      );
      if (currentStored?.content === candidate.content && mediaManifest.length === 0) {
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

        // Last pre-intent gate. Everything that this operation is about to expose is re-read and
        // re-checked while failure is still free; a throw here reaches the PREPARED failure path
        // below with zero task-created public objects in existence.
        if (params.validateBeforeWriteIntent) await params.validateBeforeWriteIntent(mediaManifest);

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
          if (startedFailure.resultCode === 'NOT_READY'
              || startedFailure.resultCode === 'PERMISSION_DENIED') {
            let terminalized = false;
            try {
              const failed = await ledger.fail(
                operation.id, epoch, ownerToken, params.adminId, startedFailure.resultCode,
              );
              terminalized = failed.resultCode === 'FAILED';
            } catch { /* the response may be lost after the fenced transition commits */ }
            if (!terminalized) {
              const reloaded = await ledger.getOperation(operation.id);
              terminalized = reloaded?.state === 'FAILED'
                && reloaded.failureCode === startedFailure.resultCode;
            }
            if (!terminalized) return { resultCode: 'RECOVERY_REQUIRED' };
          }
          return startedFailure;
        }
        if (started.resultCode !== 'WRITE_STARTED') throw new Error('WRITE_INTENT_REJECTED');

        // Durable forward-commit boundary crossed: current permission, publication readiness and
        // owner epoch/token were all revalidated inside mark_public_feed_write_started. Only now
        // may media become publicly readable, and only forward convergence follows.
        operation = { ...operation, state: 'WRITE_STARTED' };
        const promotionFailure = await promoteMedia(operation.id, mediaManifest);
        if (promotionFailure) return promotionFailure;
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
      const stored = await observeOperationStorage(
        storage, params.feedBucket, params.feedPath, baseline,
      );
      if (stored?.content === candidate.content) {
        // The canonical feed is already exact, but a crash mid-promotion can still leave part of
        // the bound manifest unpublished. Replaying it is idempotent and completes the operation.
        const promotionFailure = await promoteMedia(operation.id, mediaManifest);
        if (promotionFailure) return promotionFailure;
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
        const promotionFailure = await promoteMedia(operation.id, mediaManifest);
        if (promotionFailure) return promotionFailure;
        try {
          await deadline(storage.writeExact(params.feedBucket, params.feedPath, candidate.bytes));
        } catch {
          return { resultCode: 'PUBLICATION_IN_PROGRESS' };
        }
        const observedBytes = await observeOperationStorage(
          storage, params.feedBucket, params.feedPath, baseline,
        );
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
      const stored = await observeOperationStorage(
        storage, params.feedBucket, params.feedPath, baseline,
      );
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

    const durableVersion = finalization.versionNumber === undefined || finalization.versionNumber === null
      ? await ledger.getVersionByOperationId(operation.id)
      : null;
    const versionNumber = finalization.versionNumber === undefined || finalization.versionNumber === null
      ? durableVersion?.versionNumber ?? null : Number(finalization.versionNumber);
    return {
      resultCode: operation.state === 'COMPLETED' ? 'ALREADY_COMPLETED' : 'COMPLETED',
      operationId: operation.id, versionNumber,
      snapshotId: finalization.snapshotId ? String(finalization.snapshotId)
        : durableVersion?.publishedSnapshotId ?? null,
      auditRecordId: finalization.auditRecordId ? String(finalization.auditRecordId)
        : durableVersion?.auditRecordId ?? null,
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
