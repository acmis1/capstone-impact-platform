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
} from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { validateMediaAssetBytes } from '../storage/mediaValidation';
import {
  planPublicationArtifact,
  PublicationArtifactPlan,
  PublicationMediaSource,
} from './publicationArtifact';

export type ControlledPublicationResult =
  | { resultCode: 'COMPLETED' | 'ALREADY_COMPLETED'; attemptId: string; snapshotId: string; auditRecordId: string; recordCount: number; feedHash: string }
  | { resultCode: 'PERMISSION_DENIED' | 'PUBLICATION_IN_PROGRESS' | 'COMPENSATION_INCOMPLETE' }
  | { resultCode: 'NOT_READY'; readinessCode: string; blockers: string[] }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string; compensationFailureCode?: string };

export interface ControlledPublicationDependencies {
  assertDisposableLocalEnvironment(): void;
  getReadiness(): Promise<PublicationReadinessResult>;
  listProjects(): Promise<Project[]>;
  listProjectMedia(): Promise<PublicationMediaSource[]>;
  getLatestAttempt(): Promise<PublicationAttemptRecord | null>;
  getPublicUrl(bucket: string, path: string): string;
  beginAttempt(plan: PublicationArtifactPlan, previousFeedContent: string | null, confirmedPreviewId: string, confirmedAt: string): Promise<PublicationRpcResult>;
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
  | 'before_media_upload'
  | 'during_media_upload'
  | 'before_feed_upload'
  | 'after_feed_verification'
  | 'before_finalize'
  | 'during_compensation';

function isSuccessRpc(result: PublicationRpcResult, expected: string): boolean {
  return result.resultCode === expected;
}

function boundedFailureCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (/media storage conflict/i.test(error.message)) return 'MEDIA_STORAGE_CONFLICT';
  if (/media upload/i.test(error.message)) return 'MEDIA_UPLOAD_FAILED';
  if (/feed upload/i.test(error.message)) return 'FEED_UPLOAD_FAILED';
  if (/download/i.test(error.message)) return 'STORAGE_READ_FAILED';
  return fallback;
}

function parseStoredPlan(attempt: PublicationAttemptRecord): PublicationArtifactPlan {
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

export async function executeControlledPublication(params: {
  permissions: AdminPermission[];
  publicId: string;
  privateBucket: string;
  publicAssetsBucket: string;
  publicFeedBucket: string;
  publicFeedPath: string;
  dependencies: ControlledPublicationDependencies;
  failurePoint?: ControlledPublicationFailurePoint;
}): Promise<ControlledPublicationResult> {
  const { permissions, publicId, privateBucket, publicAssetsBucket, publicFeedBucket, publicFeedPath, dependencies, failurePoint } = params;
  if (!canPreparePublication(permissions)) return { resultCode: 'PERMISSION_DENIED' };

  try {
    dependencies.assertDisposableLocalEnvironment();
  } catch {
    return { resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT' };
  }

  let attemptId: string | null = null;
  let executionToken: string | null = null;
  let plan: PublicationArtifactPlan | null = null;
  let previousFeedContent: string | null = null;
  const createdMedia = new Map<string, string[]>();
  let feedWritten = false;
  let databaseFinalized = false;
  let failureCode = 'EXECUTION_UNAVAILABLE';

  try {
    const latest = await dependencies.getLatestAttempt();
    if (latest?.state === 'completed') {
      plan = parseStoredPlan(latest);
      await verifyStoredArtifact({ dependencies, plan, feedBucket: latest.feedStorageBucket, feedPath: latest.feedStoragePath, privateBucket });
      const ordinary = serializePublicFeedArtifact(compilePublicFeed(await dependencies.listProjects()));
      if (ordinary.content !== plan.content || ordinary.feedHash !== plan.feedHash) throw new Error('Post-publication database and feed state diverged.');
      return {
        resultCode: 'ALREADY_COMPLETED',
        attemptId: latest.id,
        snapshotId: latest.publishedSnapshotId || '',
        auditRecordId: latest.publishAuditRecordId || '',
        recordCount: latest.candidateRecordCount,
        feedHash: latest.candidateFeedHash,
      };
    }
    if (latest?.state === 'compensation_failed') return { resultCode: 'COMPENSATION_INCOMPLETE' };
    if (latest && ['prepared', 'storage_written'].includes(latest.state)) {
      if (Date.parse(latest.leaseExpiresAt) > Date.now()) return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      const claim = await dependencies.claimAttempt();
      if (claim.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      if (claim.resultCode === 'COMPENSATION_INCOMPLETE') return { resultCode: 'COMPENSATION_INCOMPLETE' };
      if (!isSuccessRpc(claim, 'ATTEMPT_CLAIMED')) throw new Error('Publication attempt could not be recovered.');
      const recovered = await dependencies.getLatestAttempt();
      if (!recovered || recovered.id !== latest.id) throw new Error('Publication attempt recovery state is invalid.');
      attemptId = recovered.id;
      executionToken = String(claim.executionToken || '');
      plan = parseStoredPlan(recovered);
      previousFeedContent = recovered.previousFeedContent;
    } else {
      const readiness = await dependencies.getReadiness();
      if (!readiness.ready || readiness.resultCode !== 'READY' || !readiness.confirmedPreviewId || !readiness.confirmedAt) {
        return { resultCode: 'NOT_READY', readinessCode: readiness.resultCode, blockers: readiness.blockers };
      }
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
      const begin = await dependencies.beginAttempt(plan, previousFeedContent, readiness.confirmedPreviewId, readiness.confirmedAt);
      if (begin.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
      if (begin.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      if (begin.resultCode === 'COMPENSATION_INCOMPLETE') return { resultCode: 'COMPENSATION_INCOMPLETE' };
      if (begin.resultCode === 'NOT_READY' || begin.resultCode === 'STALE_EVIDENCE') {
        return { resultCode: 'NOT_READY', readinessCode: String(begin.readinessCode || begin.resultCode), blockers: ['Publication readiness changed'] };
      }
      if (begin.resultCode === 'ALREADY_COMPLETED') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
      if (!isSuccessRpc(begin, 'ATTEMPT_STARTED')) throw new Error('Publication attempt could not be started.');
      attemptId = String(begin.attemptId || '');
      executionToken = String(begin.executionToken || '');
    }

    if (!attemptId || !executionToken || !plan) throw new Error('Publication attempt binding is incomplete.');
    if (failurePoint === 'before_media_upload') { failureCode = 'BEFORE_MEDIA_UPLOAD_FAILED'; throw new Error(failureCode); }

    for (let index = 0; index < plan.mediaPromotions.length; index++) {
      const media = plan.mediaPromotions[index];
      if (failurePoint === 'during_media_upload' && index === Math.min(1, plan.mediaPromotions.length - 1)) { failureCode = 'MEDIA_UPLOAD_FAILED'; throw new Error(failureCode); }
      const source = await dependencies.downloadObject(media.sourceBucket, media.sourcePath);
      if (!source) { failureCode = 'PRIVATE_MEDIA_UNAVAILABLE'; throw new Error(failureCode); }
      const validation = validateMediaAssetBytes({ fileName: media.fileName, content: source, expectedMimeType: media.mimeType, expectedFileSizeBytes: media.fileSizeBytes });
      if (!validation.valid) { failureCode = 'PRIVATE_MEDIA_INVALID'; throw new Error(failureCode); }
      const created = await dependencies.uploadNewObject(media.publicBucket, media.publicPath, source, media.mimeType);
      if (created) createdMedia.set(media.publicBucket, [...(createdMedia.get(media.publicBucket) ?? []), media.publicPath]);
      const verified = await dependencies.downloadObject(media.publicBucket, media.publicPath);
      if (!verified || !verified.equals(source)) { failureCode = 'PUBLIC_MEDIA_VERIFICATION_FAILED'; throw new Error(failureCode); }
    }

    if (failurePoint === 'before_feed_upload') { failureCode = 'BEFORE_FEED_UPLOAD_FAILED'; throw new Error(failureCode); }
    await dependencies.overwriteObject(publicFeedBucket, publicFeedPath, Buffer.from(plan.content, 'utf8'), 'application/json');
    feedWritten = true;
    await verifyStoredArtifact({ dependencies, plan, feedBucket: publicFeedBucket, feedPath: publicFeedPath, privateBucket });
    if (failurePoint === 'after_feed_verification' || failurePoint === 'during_compensation') { failureCode = 'POST_UPLOAD_FAILURE'; throw new Error(failureCode); }

    const marked = await dependencies.markStorageWritten(attemptId, executionToken, plan.feedHash, plan.recordCount);
    if (!isSuccessRpc(marked, 'STORAGE_WRITTEN')) { failureCode = 'STORAGE_EVIDENCE_REJECTED'; throw new Error(failureCode); }
    if (failurePoint === 'before_finalize') { failureCode = 'FINALIZATION_FAILED'; throw new Error(failureCode); }
    const finalization = await dependencies.finalizeAttempt(attemptId, executionToken);
    if (finalization.resultCode === 'NOT_READY' || finalization.resultCode === 'STALE_EVIDENCE') {
      failureCode = 'STALE_FINALIZATION_EVIDENCE';
      throw new Error(failureCode);
    }
    if (!isSuccessRpc(finalization, 'COMPLETED')) { failureCode = 'FINALIZATION_FAILED'; throw new Error(failureCode); }
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
    failureCode = failureCode === 'EXECUTION_UNAVAILABLE' ? boundedFailureCode(error, 'EXECUTION_UNAVAILABLE') : failureCode;
    if (databaseFinalized) return { resultCode: 'EXECUTION_FAILED', failureCode: 'POST_FINALIZATION_VERIFICATION_FAILED' };
    if (!attemptId || !executionToken) return { resultCode: 'EXECUTION_FAILED', failureCode };
    let compensationFailureCode: string | undefined;
    try {
      if (failurePoint === 'during_compensation') throw new Error('Injected compensation failure.');
      if (feedWritten) {
        if (previousFeedContent === null) await dependencies.removeObjects(publicFeedBucket, [publicFeedPath]);
        else await dependencies.overwriteObject(publicFeedBucket, publicFeedPath, Buffer.from(previousFeedContent, 'utf8'), 'application/json');
      }
      for (const [bucket, paths] of createdMedia) await dependencies.removeObjects(bucket, paths);
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
