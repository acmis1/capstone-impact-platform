import { createHash } from 'crypto';
import { AdminPermission } from '../auth/authTypes';
import { canPreparePublication } from '../auth/permissions';
import { PublicationReadinessResult } from '../domain/publicationReadiness';
import { Project } from '../domain/project';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import {
  PublicationAttemptRecord,
  PublicationRpcResult,
  PublishAuditRecord,
  PublishedSnapshotRecord,
} from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { validateMediaAssetBytes } from '../storage/mediaValidationCore';
import {
  planPublicationArtifact,
  PublicationArtifactPlan,
  PublicationMediaBinding,
  PublicationMediaSource,
} from './publicationArtifact';

export type ControlledPublicationResult =
  | { resultCode: 'COMPLETED' | 'ALREADY_COMPLETED'; attemptId: string; snapshotId: string; auditRecordId: string; recordCount: number; feedHash: string }
  | { resultCode: 'PERMISSION_DENIED' | 'PUBLICATION_IN_PROGRESS' | 'COMPENSATION_INCOMPLETE' | 'ATTEMPT_OWNER_MISMATCH' }
  | { resultCode: 'NOT_READY'; readinessCode: string; blockers: string[] }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string; compensationFailureCode?: string };

export interface ControlledPublicationDependencies {
  assertDisposableLocalEnvironment(): void;
  getReadiness(): Promise<PublicationReadinessResult>;
  listProjects(): Promise<Project[]>;
  listProjectMedia(): Promise<PublicationMediaSource[]>;
  getCompletedAttempt(): Promise<PublicationAttemptRecord | null>;
  getRecoverableAttempt(): Promise<PublicationAttemptRecord | null>;
  getPublishedSnapshot(snapshotId: string): Promise<PublishedSnapshotRecord | null>;
  getPublishAuditRecord(auditRecordId: string): Promise<PublishAuditRecord | null>;
  getPublicUrl(bucket: string, path: string): string;
  reserveAttempt(confirmedPreviewId: string, confirmedAt: string): Promise<PublicationRpcResult>;
  prepareAttempt(attemptId: string, executionToken: string, plan: PublicationArtifactPlan, mediaManifest: PublicationMediaBinding[], previousFeedContent: string | null): Promise<PublicationRpcResult>;
  claimAttempt(): Promise<PublicationRpcResult>;
  markStorageWritten(attemptId: string, executionToken: string, feedHash: string, recordCount: number): Promise<PublicationRpcResult>;
  finalizeAttempt(attemptId: string, executionToken: string): Promise<PublicationRpcResult>;
  failAttempt(attemptId: string, executionToken: string, failureCode: string, compensationFailureCode?: string): Promise<PublicationRpcResult>;
  downloadObject(bucket: string, path: string): Promise<Buffer | null>;
  uploadNewObject(bucket: string, path: string, content: Buffer, contentType: string): Promise<boolean>;
  overwriteObject(bucket: string, path: string, content: Buffer, contentType: string): Promise<void>;
  removeObjects(bucket: string, paths: string[]): Promise<void>;
}

export type ControlledPublicationFailurePoint =
  | 'after_reservation'
  | 'before_artifact_bind'
  | 'before_media_upload'
  | 'during_media_upload'
  | 'simulated_process_crash_after_media_write'
  | 'before_feed_upload'
  | 'after_feed_verification'
  | 'before_finalize'
  | 'during_compensation';

/**
 * Test-only synchronization points. Production callers never supply these; they exist so the
 * reservation-before-baseline invariant can be proven with a deterministic barrier instead of
 * scheduler luck.
 */
export interface ControlledPublicationBarriers {
  afterReservation?(): Promise<void>;
}

/** A failure whose bounded, non-sensitive code is already known. */
class BoundedFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BoundedFailure';
  }
}

/**
 * Models process death for the crash/recovery regressions: no compensation and no durable
 * failure record run, exactly as if the Node process had been killed mid-execution.
 */
class SimulatedProcessCrash extends Error {
  constructor() {
    super('SIMULATED_PROCESS_CRASH');
    this.name = 'SimulatedProcessCrash';
  }
}

function isSuccessRpc(result: PublicationRpcResult, expected: string): boolean {
  return result.resultCode === expected;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function boundedFailureCode(error: unknown, fallback: string): string {
  if (error instanceof BoundedFailure) return error.code;
  if (!(error instanceof Error)) return fallback;
  if (/media storage conflict/i.test(error.message)) return 'MEDIA_STORAGE_CONFLICT';
  if (/media upload/i.test(error.message)) return 'MEDIA_UPLOAD_FAILED';
  if (/feed upload/i.test(error.message)) return 'FEED_UPLOAD_FAILED';
  if (/download/i.test(error.message)) return 'STORAGE_READ_FAILED';
  return fallback;
}

function parseStoredPlan(attempt: PublicationAttemptRecord): PublicationArtifactPlan {
  if (attempt.candidateFeedContent === null || attempt.candidateFeedHash === null
    || attempt.candidateRecordCount === null || attempt.mediaManifest === null) {
    throw new BoundedFailure('ATTEMPT_ARTIFACT_UNBOUND');
  }
  const parsed = JSON.parse(attempt.candidateFeedContent) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Stored publication artifact is invalid.');
  const artifact = serializePublicFeedArtifact(parsed);
  if (artifact.feedHash !== attempt.candidateFeedHash || artifact.recordCount !== attempt.candidateRecordCount) {
    throw new Error('Stored publication artifact binding is invalid.');
  }
  return { feed: parsed as PublicationArtifactPlan['feed'], ...artifact, mediaPromotions: attempt.mediaManifest };
}

async function verifyStoredArtifact(params: {
  dependencies: ControlledPublicationDependencies;
  plan: PublicationArtifactPlan;
  feedBucket: string;
  feedPath: string;
  privateBucket: string;
}): Promise<void> {
  const { dependencies, plan, feedBucket, feedPath, privateBucket } = params;
  const retrieved = await dependencies.downloadObject(feedBucket, feedPath);
  if (!retrieved || !retrieved.equals(Buffer.from(plan.content, 'utf8'))) {
    throw new Error('Uploaded publication feed bytes do not match.');
  }
  const parsed = JSON.parse(retrieved.toString('utf8')) as unknown;
  if (!Array.isArray(parsed) || !validatePublicFeed(parsed).valid) {
    throw new Error('Uploaded publication feed contract is invalid.');
  }
  const artifact = serializePublicFeedArtifact(parsed);
  if (artifact.feedHash !== plan.feedHash || artifact.recordCount !== plan.recordCount ||
      retrieved.toString('utf8').includes(privateBucket) || retrieved.toString('utf8').includes('/drafts/')) {
    throw new Error('Uploaded publication feed evidence does not match.');
  }
}

/**
 * Validates a target that has already been published successfully.
 *
 * The historical full-feed artifact stored on the completed attempt is event evidence of the
 * publication that happened at that moment — it is NOT the eternal expected global feed. Once
 * another project publishes legitimately, the canonical feed evolves past it. This therefore
 * verifies durable TARGET-SPECIFIC invariants plus CURRENT global consistency, and never
 * compares the current canonical feed against the historical artifact.
 */
async function verifyAlreadyCompletedPublication(params: {
  dependencies: ControlledPublicationDependencies;
  completed: PublicationAttemptRecord;
  publicId: string;
  privateBucket: string;
  publicFeedBucket: string;
  publicFeedPath: string;
}): Promise<ControlledPublicationResult> {
  const { dependencies, completed, publicId, privateBucket, publicFeedBucket, publicFeedPath } = params;
  if (!completed.publishedSnapshotId || !completed.publishAuditRecordId || completed.artifactBoundAt === null
    || completed.candidateFeedHash === null || completed.candidateRecordCount === null
    || completed.feedStorageBucket === null || completed.feedStoragePath === null || completed.mediaManifest === null) {
    throw new BoundedFailure('COMPLETED_ATTEMPT_EVIDENCE_INCOMPLETE');
  }

  const projects = await dependencies.listProjects();
  const targets = projects.filter((project) => project.publicId === publicId);
  if (targets.length !== 1 || targets[0].status !== 'published') {
    throw new BoundedFailure('COMPLETED_PROJECT_STATE_INVALID');
  }

  const snapshot = await dependencies.getPublishedSnapshot(completed.publishedSnapshotId);
  if (!snapshot || snapshot.feedHash !== completed.candidateFeedHash
    || snapshot.recordCount !== completed.candidateRecordCount
    || snapshot.storageBucket !== completed.feedStorageBucket
    || snapshot.storagePath !== `${completed.feedStorageBucket}/${completed.feedStoragePath}`
    || snapshot.createdBy !== completed.adminId) {
    throw new BoundedFailure('COMPLETED_SNAPSHOT_EVIDENCE_INVALID');
  }

  const audit = await dependencies.getPublishAuditRecord(completed.publishAuditRecordId);
  if (!audit || audit.projectId !== completed.projectId || audit.adminId !== completed.adminId
    || audit.actionTaken !== 'publish' || audit.fromStatus !== 'approved' || audit.toStatus !== 'published') {
    throw new BoundedFailure('COMPLETED_AUDIT_EVIDENCE_INVALID');
  }

  const mediaAssets = await dependencies.listProjectMedia();
  for (const binding of completed.mediaManifest) {
    const asset = mediaAssets.find((item) => item.id === binding.mediaAssetId);
    if (!asset || !asset.isPublicApproved || asset.publicStorageBucket !== binding.publicBucket
      || asset.publicStoragePath !== binding.publicPath || asset.publicUrl !== binding.publicUrl) {
      throw new BoundedFailure('COMPLETED_MEDIA_MAPPING_INVALID');
    }
  }

  // Current global consistency: today's authoritative projects must still compile to exactly
  // today's canonical stored feed, and that feed must still contain this target.
  const current = serializePublicFeedArtifact(compilePublicFeed(projects));
  const stored = await dependencies.downloadObject(publicFeedBucket, publicFeedPath);
  if (!stored || stored.toString('utf8') !== current.content) {
    throw new BoundedFailure('CURRENT_FEED_DIVERGED');
  }
  const parsedCurrent = JSON.parse(current.content) as { publicId?: string }[];
  if (!validatePublicFeed(parsedCurrent).valid
    || current.content.includes(privateBucket) || current.content.includes('/drafts/')) {
    throw new BoundedFailure('CURRENT_FEED_CONTRACT_INVALID');
  }
  if (!parsedCurrent.some((record) => record.publicId === publicId)) {
    throw new BoundedFailure('CURRENT_FEED_MISSING_TARGET');
  }

  return {
    resultCode: 'ALREADY_COMPLETED',
    attemptId: completed.id,
    snapshotId: completed.publishedSnapshotId,
    auditRecordId: completed.publishAuditRecordId,
    recordCount: completed.candidateRecordCount,
    feedHash: completed.candidateFeedHash,
  };
}

/**
 * Captures the durable public-media ownership baseline while the attempt already holds global
 * exclusivity. For every deterministic destination this records whether the object existed
 * BEFORE this attempt wrote anything, so compensation ownership no longer depends on a
 * process-local collection surviving a crash.
 */
async function captureMediaBindings(
  dependencies: ControlledPublicationDependencies,
  plan: PublicationArtifactPlan,
): Promise<{ bindings: PublicationMediaBinding[]; sourceBytes: Map<string, Buffer> }> {
  const bindings: PublicationMediaBinding[] = [];
  const sourceBytes = new Map<string, Buffer>();
  for (const media of plan.mediaPromotions) {
    const source = await dependencies.downloadObject(media.sourceBucket, media.sourcePath);
    if (!source) throw new BoundedFailure('PRIVATE_MEDIA_UNAVAILABLE');
    const validation = validateMediaAssetBytes({ fileName: media.fileName, content: source, expectedMimeType: media.mimeType, expectedFileSizeBytes: media.fileSizeBytes });
    if (!validation.valid) throw new BoundedFailure('PRIVATE_MEDIA_INVALID');

    const existing = await dependencies.downloadObject(media.publicBucket, media.publicPath);
    if (existing && !existing.equals(source)) {
      // Fail closed: never overwrite a public object this attempt does not own.
      throw new BoundedFailure('MEDIA_STORAGE_CONFLICT');
    }
    bindings.push({ ...media, preExisting: existing !== null, sourceSha256: sha256(source) });
    sourceBytes.set(media.mediaAssetId, source);
  }
  return { bindings, sourceBytes };
}

export async function executeControlledPublication(params: {
  permissions: AdminPermission[];
  publicId: string;
  privateBucket: string;
  publicAssetsBucket: string;
  publicFeedBucket: string;
  publicFeedPath: string;
  dependencies: ControlledPublicationDependencies;
  failurePoint?: ControlledPublicationFailurePoint;
  barriers?: ControlledPublicationBarriers;
}): Promise<ControlledPublicationResult> {
  const { permissions, publicId, privateBucket, publicAssetsBucket, publicFeedBucket, publicFeedPath, dependencies, failurePoint, barriers } = params;
  if (!canPreparePublication(permissions)) return { resultCode: 'PERMISSION_DENIED' };

  try {
    dependencies.assertDisposableLocalEnvironment();
  } catch {
    return { resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT' };
  }

  let attemptId: string | null = null;
  let executionToken: string | null = null;
  let plan: PublicationArtifactPlan | null = null;
  let mediaBindings: PublicationMediaBinding[] | null = null;
  let sourceBytes = new Map<string, Buffer>();
  let previousFeedContent: string | null = null;
  let feedWritten = false;
  let databaseFinalized = false;

  try {
    // An already-published target is validated against durable target-specific evidence only.
    const completed = await dependencies.getCompletedAttempt();
    if (completed) {
      return await verifyAlreadyCompletedPublication({ dependencies, completed, publicId, privateBucket, publicFeedBucket, publicFeedPath });
    }

    const recoverable = await dependencies.getRecoverableAttempt();
    if (recoverable) {
      if (Date.parse(recoverable.leaseExpiresAt) > Date.now()) return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      const claim = await dependencies.claimAttempt();
      if (claim.resultCode === 'ATTEMPT_OWNER_MISMATCH') return { resultCode: 'ATTEMPT_OWNER_MISMATCH' };
      if (claim.resultCode === 'PUBLICATION_IN_PROGRESS' || claim.resultCode === 'ATTEMPT_NOT_FOUND') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      if (claim.resultCode === 'COMPENSATION_INCOMPLETE') return { resultCode: 'COMPENSATION_INCOMPLETE' };
      if (claim.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
      if (!isSuccessRpc(claim, 'ATTEMPT_CLAIMED')) throw new Error('Publication attempt could not be recovered.');
      const reclaimed = await dependencies.getRecoverableAttempt();
      if (!reclaimed || reclaimed.id !== recoverable.id) throw new Error('Publication attempt recovery state is invalid.');
      attemptId = reclaimed.id;
      executionToken = String(claim.executionToken || '');
      if (reclaimed.artifactBoundAt !== null) {
        // A recovered attempt always reuses its own durably bound artifact, previous-feed
        // evidence and media ownership baseline — never whatever is current now.
        plan = parseStoredPlan(reclaimed);
        mediaBindings = reclaimed.mediaManifest;
        previousFeedContent = reclaimed.previousFeedContent;
      }
    } else {
      const readiness = await dependencies.getReadiness();
      if (!readiness.ready || readiness.resultCode !== 'READY' || !readiness.confirmedPreviewId || !readiness.confirmedAt) {
        return { resultCode: 'NOT_READY', readinessCode: readiness.resultCode, blockers: readiness.blockers };
      }
      // Phase A. Global exclusivity is established here, before any global baseline read.
      const reservation = await dependencies.reserveAttempt(readiness.confirmedPreviewId, readiness.confirmedAt);
      if (reservation.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
      if (reservation.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      if (reservation.resultCode === 'COMPENSATION_INCOMPLETE') return { resultCode: 'COMPENSATION_INCOMPLETE' };
      if (reservation.resultCode === 'NOT_READY' || reservation.resultCode === 'STALE_EVIDENCE') {
        return { resultCode: 'NOT_READY', readinessCode: String(reservation.readinessCode || reservation.resultCode), blockers: ['Publication readiness changed'] };
      }
      if (reservation.resultCode === 'ALREADY_COMPLETED') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      if (!isSuccessRpc(reservation, 'ATTEMPT_RESERVED')) throw new Error('Publication attempt could not be reserved.');
      attemptId = String(reservation.attemptId || '');
      executionToken = String(reservation.executionToken || '');
    }

    if (!attemptId || !executionToken) throw new Error('Publication attempt binding is incomplete.');

    if (plan === null) {
      // Phase B. Only now — under an existing durable reservation — may the mutable global
      // publication baseline be observed and bound to this attempt.
      if (barriers?.afterReservation) await barriers.afterReservation();
      if (failurePoint === 'after_reservation') throw new BoundedFailure('AFTER_RESERVATION_FAILED');

      const [projects, mediaAssets] = await Promise.all([dependencies.listProjects(), dependencies.listProjectMedia()]);
      plan = planPublicationArtifact({
        projects,
        targetPublicId: publicId,
        mediaAssets,
        privateBucket,
        publicBucket: publicAssetsBucket,
        getPublicUrl: (bucket, path) => dependencies.getPublicUrl(bucket, path),
      });
      const previous = await dependencies.downloadObject(publicFeedBucket, publicFeedPath);
      previousFeedContent = previous?.toString('utf8') ?? null;
      const captured = await captureMediaBindings(dependencies, plan);
      mediaBindings = captured.bindings;
      sourceBytes = captured.sourceBytes;

      if (failurePoint === 'before_artifact_bind') throw new BoundedFailure('BEFORE_ARTIFACT_BIND_FAILED');
      const bound = await dependencies.prepareAttempt(attemptId, executionToken, plan, mediaBindings, previousFeedContent);
      if (bound.resultCode === 'NOT_READY' || bound.resultCode === 'STALE_EVIDENCE') {
        return { resultCode: 'NOT_READY', readinessCode: String(bound.readinessCode || bound.resultCode), blockers: ['Publication readiness changed'] };
      }
      if (!isSuccessRpc(bound, 'ARTIFACT_BOUND')) throw new BoundedFailure('ARTIFACT_BINDING_REJECTED');
    }

    if (!plan || !mediaBindings) throw new Error('Publication artifact binding is incomplete.');
    if (failurePoint === 'before_media_upload') throw new BoundedFailure('BEFORE_MEDIA_UPLOAD_FAILED');

    // Phase C. External storage execution.
    for (let index = 0; index < mediaBindings.length; index++) {
      const media = mediaBindings[index];
      if (failurePoint === 'during_media_upload' && index === Math.min(1, mediaBindings.length - 1)) {
        throw new BoundedFailure('MEDIA_UPLOAD_FAILED');
      }
      let source = sourceBytes.get(media.mediaAssetId) ?? null;
      if (!source) {
        source = await dependencies.downloadObject(media.sourceBucket, media.sourcePath);
        if (!source) throw new BoundedFailure('PRIVATE_MEDIA_UNAVAILABLE');
        if (sha256(source) !== media.sourceSha256) throw new BoundedFailure('PRIVATE_MEDIA_CHANGED');
        sourceBytes.set(media.mediaAssetId, source);
      }
      const validation = validateMediaAssetBytes({ fileName: media.fileName, content: source, expectedMimeType: media.mimeType, expectedFileSizeBytes: media.fileSizeBytes });
      if (!validation.valid) throw new BoundedFailure('PRIVATE_MEDIA_INVALID');
      await dependencies.uploadNewObject(media.publicBucket, media.publicPath, source, media.mimeType);
      const verified = await dependencies.downloadObject(media.publicBucket, media.publicPath);
      if (!verified || !verified.equals(source)) throw new BoundedFailure('PUBLIC_MEDIA_VERIFICATION_FAILED');
      if (failurePoint === 'simulated_process_crash_after_media_write') throw new SimulatedProcessCrash();
    }

    if (failurePoint === 'before_feed_upload') throw new BoundedFailure('BEFORE_FEED_UPLOAD_FAILED');
    await dependencies.overwriteObject(publicFeedBucket, publicFeedPath, Buffer.from(plan.content, 'utf8'), 'application/json');
    feedWritten = true;
    await verifyStoredArtifact({ dependencies, plan, feedBucket: publicFeedBucket, feedPath: publicFeedPath, privateBucket });
    if (failurePoint === 'after_feed_verification' || failurePoint === 'during_compensation') throw new BoundedFailure('POST_UPLOAD_FAILURE');

    const marked = await dependencies.markStorageWritten(attemptId, executionToken, plan.feedHash, plan.recordCount);
    if (!isSuccessRpc(marked, 'STORAGE_WRITTEN')) throw new BoundedFailure('STORAGE_EVIDENCE_REJECTED');
    if (failurePoint === 'before_finalize') throw new BoundedFailure('FINALIZATION_FAILED');

    // Phase D. Atomic DB finalization.
    const finalization = await dependencies.finalizeAttempt(attemptId, executionToken);
    if (finalization.resultCode === 'NOT_READY' || finalization.resultCode === 'STALE_EVIDENCE') {
      throw new BoundedFailure('STALE_FINALIZATION_EVIDENCE');
    }
    if (!isSuccessRpc(finalization, 'COMPLETED')) throw new BoundedFailure('FINALIZATION_FAILED');
    databaseFinalized = true;

    const ordinary = serializePublicFeedArtifact(compilePublicFeed(await dependencies.listProjects()));
    if (ordinary.content !== plan.content || ordinary.feedHash !== plan.feedHash) throw new Error('Post-publication database and feed state diverged.');
    await verifyStoredArtifact({ dependencies, plan, feedBucket: publicFeedBucket, feedPath: publicFeedPath, privateBucket });
    return {
      resultCode: 'COMPLETED',
      attemptId,
      snapshotId: String(finalization.snapshotId || ''),
      auditRecordId: String(finalization.auditRecordId || ''),
      recordCount: plan.recordCount,
      feedHash: plan.feedHash,
    };
  } catch (error) {
    if (error instanceof SimulatedProcessCrash) throw error;
    const failureCode = boundedFailureCode(error, 'EXECUTION_UNAVAILABLE');
    if (databaseFinalized) return { resultCode: 'EXECUTION_FAILED', failureCode: 'POST_FINALIZATION_VERIFICATION_FAILED' };
    if (!attemptId || !executionToken) return { resultCode: 'EXECUTION_FAILED', failureCode };
    let compensationFailureCode: string | undefined;
    try {
      if (failurePoint === 'during_compensation') throw new Error('Injected compensation failure.');
      if (feedWritten) {
        if (previousFeedContent === null) await dependencies.removeObjects(publicFeedBucket, [publicFeedPath]);
        else await dependencies.overwriteObject(publicFeedBucket, publicFeedPath, Buffer.from(previousFeedContent, 'utf8'), 'application/json');
      }
      // Durable ownership: remove every destination that did not exist before THIS attempt,
      // regardless of which process invocation actually created it.
      const owned = new Map<string, string[]>();
      for (const media of mediaBindings ?? []) {
        if (media.preExisting) continue;
        owned.set(media.publicBucket, [...(owned.get(media.publicBucket) ?? []), media.publicPath]);
      }
      for (const [bucket, paths] of owned) await dependencies.removeObjects(bucket, paths);
    } catch {
      compensationFailureCode = 'COMPENSATION_FAILED';
    }
    try {
      await dependencies.failAttempt(attemptId, executionToken, failureCode, compensationFailureCode);
    } catch {
      compensationFailureCode = compensationFailureCode || 'ATTEMPT_FAILURE_RECORD_FAILED';
    }
    return compensationFailureCode
      ? { resultCode: 'EXECUTION_FAILED', failureCode, compensationFailureCode }
      : { resultCode: 'EXECUTION_FAILED', failureCode };
  }
}
