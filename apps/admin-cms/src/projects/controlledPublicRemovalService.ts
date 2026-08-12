import { AdminPermission } from '../auth/authTypes';
import { hasPermission } from '../auth/permissions';
import { Project } from '../domain/project';
import { compilePublicFeed, compilePublicRemovalCandidateFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { ArchiveAuditRecord, PublicRemovalAttemptRecord, PublicRemovalRpcResult } from '../repositories/SupabasePublicRemovalRepositoryCore';

export interface PublicRemovalArtifact {
  content: string;
  feedHash: string;
  recordCount: number;
}

export type ControlledPublicRemovalResult =
  | ({ resultCode: 'COMPLETED' | 'ALREADY_COMPLETED'; attemptId: string; auditRecordId: string } & PublicRemovalArtifact)
  | { resultCode: 'PERMISSION_DENIED' | 'PUBLICATION_IN_PROGRESS' | 'COMPENSATION_INCOMPLETE' | 'ATTEMPT_OWNER_MISMATCH' | 'ARCHIVE_REASON_MISMATCH' | 'NOT_PUBLISHED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string; compensationFailureCode?: string };

export interface ControlledPublicRemovalDependencies {
  assertDisposableLocalEnvironment(): void;
  listProjects(): Promise<Project[]>;
  getCompletedAttempt(): Promise<PublicRemovalAttemptRecord | null>;
  getRecoverableAttempt(): Promise<PublicRemovalAttemptRecord | null>;
  getArchiveAuditRecord(id: string): Promise<ArchiveAuditRecord | null>;
  reserveAttempt(reason: string): Promise<PublicRemovalRpcResult>;
  prepareAttempt(attemptId: string, token: string, artifact: PublicRemovalArtifact, previous: string): Promise<PublicRemovalRpcResult>;
  claimAttempt(): Promise<PublicRemovalRpcResult>;
  markStorageWritten(attemptId: string, token: string, hash: string, count: number): Promise<PublicRemovalRpcResult>;
  finalizeAttempt(attemptId: string, token: string): Promise<PublicRemovalRpcResult>;
  failAttempt(attemptId: string, token: string, failure: string, compensation?: string): Promise<PublicRemovalRpcResult>;
  downloadFeed(): Promise<Buffer | null>;
  overwriteFeed(content: Buffer): Promise<void>;
}

export type PublicRemovalFailurePoint = 'after_reservation' | 'after_feed_write' | 'before_finalize' | 'during_compensation';
export interface PublicRemovalBarriers { afterReservation?(): Promise<void> }

class BoundedFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
class SimulatedProcessCrash extends Error {}

function parseArtifact(attempt: PublicRemovalAttemptRecord): PublicRemovalArtifact {
  if (attempt.candidateFeedContent === null || attempt.candidateFeedHash === null || attempt.candidateRecordCount === null) {
    throw new BoundedFailure('BOUND_ARTIFACT_INVALID');
  }
  const parsed = JSON.parse(attempt.candidateFeedContent) as unknown;
  const validation = Array.isArray(parsed) ? validatePublicFeed(parsed) : { valid: false };
  const serialized = Array.isArray(parsed) ? serializePublicFeedArtifact(parsed) : null;
  if (!validation.valid || !serialized || serialized.content !== attempt.candidateFeedContent || serialized.feedHash !== attempt.candidateFeedHash || serialized.recordCount !== attempt.candidateRecordCount) {
    throw new BoundedFailure('BOUND_ARTIFACT_INVALID');
  }
  return { content: attempt.candidateFeedContent, feedHash: attempt.candidateFeedHash, recordCount: attempt.candidateRecordCount };
}

async function verifyStored(dependencies: ControlledPublicRemovalDependencies, artifact: PublicRemovalArtifact, publicId: string): Promise<void> {
  const stored = await dependencies.downloadFeed();
  if (!stored || stored.toString('utf8') !== artifact.content) throw new BoundedFailure('FEED_VERIFICATION_FAILED');
  const parsed = JSON.parse(stored.toString('utf8')) as unknown;
  if (!Array.isArray(parsed) || !validatePublicFeed(parsed).valid || parsed.length !== artifact.recordCount || parsed.some((row) => row && typeof row === 'object' && (row as Record<string, unknown>).publicId === publicId)) {
    throw new BoundedFailure('FEED_VERIFICATION_FAILED');
  }
  const serialized = serializePublicFeedArtifact(parsed);
  if (serialized.feedHash !== artifact.feedHash || artifact.content.includes('/drafts/')) throw new BoundedFailure('FEED_VERIFICATION_FAILED');
}

async function verifyCompleted(params: { dependencies: ControlledPublicRemovalDependencies; attempt: PublicRemovalAttemptRecord; publicId: string; reason: string }): Promise<ControlledPublicRemovalResult> {
  const { dependencies, attempt, publicId, reason } = params;
  if (attempt.archiveReason !== reason) return { resultCode: 'ARCHIVE_REASON_MISMATCH' };
  const artifact = parseArtifact(attempt);
  const projects = await dependencies.listProjects();
  const target = projects.filter((project) => project.publicId === publicId);
  if (target.length !== 1 || target[0].status !== 'archived' || target[0].archivedFromStatus !== 'published' || target[0].archiveReason !== attempt.archiveReason || !target[0].archivedAt || target[0].pendingRemovalFromPublic !== true || target[0].publicRemovalCompletedAt) {
    throw new BoundedFailure('COMPLETED_EVIDENCE_INVALID');
  }
  const current = serializePublicFeedArtifact(compilePublicFeed(projects));
  const stored = await dependencies.downloadFeed();
  if (!stored || stored.toString('utf8') !== current.content || current.content.includes(`"publicId": "${publicId}"`)) throw new BoundedFailure('CURRENT_FEED_DIVERGED');
  if (!attempt.archiveAuditRecordId) throw new BoundedFailure('COMPLETED_EVIDENCE_INVALID');
  const audit = await dependencies.getArchiveAuditRecord(attempt.archiveAuditRecordId);
  if (!audit || audit.projectId !== attempt.projectId || audit.adminId !== attempt.adminId || audit.actionTaken !== 'archive' || audit.fromStatus !== 'published' || audit.toStatus !== 'archived' || audit.comments !== attempt.archiveReason) {
    throw new BoundedFailure('COMPLETED_EVIDENCE_INVALID');
  }
  return { resultCode: 'ALREADY_COMPLETED', attemptId: attempt.id, auditRecordId: audit.id, ...artifact };
}

export async function executeControlledPublicRemoval(params: {
  permissions: AdminPermission[];
  publicId: string;
  archiveReason: string;
  dependencies: ControlledPublicRemovalDependencies;
  failurePoint?: PublicRemovalFailurePoint;
  barriers?: PublicRemovalBarriers;
}): Promise<ControlledPublicRemovalResult> {
  const { permissions, publicId, archiveReason, dependencies, failurePoint, barriers } = params;
  if (!hasPermission(permissions, 'projects.archive')) return { resultCode: 'PERMISSION_DENIED' };
  try { dependencies.assertDisposableLocalEnvironment(); } catch { return { resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT' }; }

  let attemptId: string | null = null;
  let token: string | null = null;
  let artifact: PublicRemovalArtifact | null = null;
  let previous: string | null = null;
  let feedWritten = false;

  try {
    const completed = await dependencies.getCompletedAttempt();
    if (completed) return await verifyCompleted({ dependencies, attempt: completed, publicId, reason: archiveReason });

    const recoverable = await dependencies.getRecoverableAttempt();
    if (recoverable) {
      if (recoverable.archiveReason !== archiveReason) return { resultCode: 'ARCHIVE_REASON_MISMATCH' };
      if (Date.parse(recoverable.leaseExpiresAt) > Date.now()) return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      const claim = await dependencies.claimAttempt();
      if (claim.resultCode === 'ATTEMPT_OWNER_MISMATCH') return { resultCode: 'ATTEMPT_OWNER_MISMATCH' };
      if (claim.resultCode === 'COMPENSATION_INCOMPLETE') return { resultCode: 'COMPENSATION_INCOMPLETE' };
      if (claim.resultCode !== 'ATTEMPT_CLAIMED') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      const claimed = await dependencies.getRecoverableAttempt();
      if (!claimed || claimed.id !== recoverable.id || claimed.archiveReason !== archiveReason) throw new BoundedFailure('RECOVERY_STATE_INVALID');
      attemptId = claimed.id;
      token = String(claim.executionToken || '');
      if (claimed.artifactBoundAt !== null) {
        artifact = parseArtifact(claimed);
        previous = claimed.previousFeedContent;
        if (!claimed.previousFeedExisted || previous === null) throw new BoundedFailure('PREVIOUS_FEED_EVIDENCE_INVALID');
        feedWritten = claimed.state === 'storage_written';
      }
    } else {
      const reservation = await dependencies.reserveAttempt(archiveReason);
      if (reservation.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
      if (reservation.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      if (reservation.resultCode === 'COMPENSATION_INCOMPLETE') return { resultCode: 'COMPENSATION_INCOMPLETE' };
      if (reservation.resultCode === 'NOT_PUBLISHED') return { resultCode: 'NOT_PUBLISHED' };
      if (reservation.resultCode === 'ALREADY_COMPLETED') {
        const nowCompleted = await dependencies.getCompletedAttempt();
        if (!nowCompleted) throw new BoundedFailure('COMPLETED_EVIDENCE_INVALID');
        return await verifyCompleted({ dependencies, attempt: nowCompleted, publicId, reason: archiveReason });
      }
      if (reservation.resultCode !== 'ATTEMPT_RESERVED') throw new BoundedFailure('RESERVATION_FAILED');
      attemptId = String(reservation.attemptId || '');
      token = String(reservation.executionToken || '');
    }

    if (!attemptId || !token) throw new BoundedFailure('ATTEMPT_BINDING_INVALID');
    if (!artifact) {
      if (barriers?.afterReservation) await barriers.afterReservation();
      if (failurePoint === 'after_reservation') throw new BoundedFailure('AFTER_RESERVATION_FAILED');
      const projects = await dependencies.listProjects();
      const current = serializePublicFeedArtifact(compilePublicFeed(projects));
      const stored = await dependencies.downloadFeed();
      if (!stored || stored.toString('utf8') !== current.content) throw new BoundedFailure('CURRENT_FEED_DIVERGED');
      const parsed = JSON.parse(current.content) as Array<Record<string, unknown>>;
      if (parsed.filter((row) => row.publicId === publicId).length !== 1) throw new BoundedFailure('CURRENT_FEED_DIVERGED');
      const candidate = compilePublicRemovalCandidateFeed(projects, publicId);
      if (!validatePublicFeed(candidate).valid) throw new BoundedFailure('CANDIDATE_FEED_INVALID');
      artifact = serializePublicFeedArtifact(candidate);
      previous = current.content;
      const prepared = await dependencies.prepareAttempt(attemptId, token, artifact, previous);
      if (prepared.resultCode === 'NOT_PUBLISHED') return { resultCode: 'NOT_PUBLISHED' };
      if (prepared.resultCode !== 'ARTIFACT_BOUND') throw new BoundedFailure('ARTIFACT_BINDING_REJECTED');
    }

    if (previous === null) throw new BoundedFailure('PREVIOUS_FEED_EVIDENCE_INVALID');
    if (!feedWritten) {
      await dependencies.overwriteFeed(Buffer.from(artifact.content, 'utf8'));
      feedWritten = true;
      await verifyStored(dependencies, artifact, publicId);
      if (failurePoint === 'after_feed_write') throw new SimulatedProcessCrash();
      const marked = await dependencies.markStorageWritten(attemptId, token, artifact.feedHash, artifact.recordCount);
      if (marked.resultCode !== 'STORAGE_WRITTEN') throw new BoundedFailure('STORAGE_EVIDENCE_REJECTED');
    } else {
      await verifyStored(dependencies, artifact, publicId);
    }
    if (failurePoint === 'before_finalize') throw new BoundedFailure('FINALIZATION_FAILED');
    if (failurePoint === 'during_compensation') throw new BoundedFailure('POST_STORAGE_FAILURE');
    const finalized = await dependencies.finalizeAttempt(attemptId, token);
    if (finalized.resultCode === 'NOT_PUBLISHED') throw new BoundedFailure('PROJECT_STATE_CHANGED');
    if (finalized.resultCode !== 'COMPLETED') throw new BoundedFailure('FINALIZATION_FAILED');
    const projects = await dependencies.listProjects();
    const converged = serializePublicFeedArtifact(compilePublicFeed(projects));
    if (converged.content !== artifact.content) throw new BoundedFailure('POST_FINALIZATION_DIVERGED');
    await verifyStored(dependencies, artifact, publicId);
    return { resultCode: 'COMPLETED', attemptId, auditRecordId: String(finalized.auditRecordId || ''), ...artifact };
  } catch (error) {
    if (error instanceof SimulatedProcessCrash) throw error;
    const failureCode = error instanceof BoundedFailure ? error.code : 'EXECUTION_UNAVAILABLE';
    if (!attemptId || !token) return { resultCode: 'EXECUTION_FAILED', failureCode };
    let compensationFailureCode: string | undefined;
    try {
      if (failurePoint === 'during_compensation') throw new Error('Injected compensation failure.');
      if (feedWritten) {
        if (previous === null) throw new Error('Previous feed unavailable.');
        await dependencies.overwriteFeed(Buffer.from(previous, 'utf8'));
        const restored = await dependencies.downloadFeed();
        if (!restored || restored.toString('utf8') !== previous) throw new Error('Feed restoration verification failed.');
      }
    } catch { compensationFailureCode = 'COMPENSATION_FAILED'; }
    try { await dependencies.failAttempt(attemptId, token, failureCode, compensationFailureCode); }
    catch { compensationFailureCode ||= 'ATTEMPT_FAILURE_RECORD_FAILED'; }
    return compensationFailureCode ? { resultCode: 'EXECUTION_FAILED', failureCode, compensationFailureCode } : { resultCode: 'EXECUTION_FAILED', failureCode };
  }
}
