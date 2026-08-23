import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { SupabasePublicationExecutionRepositoryCore } from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { ControlledPublicationDependencies } from './controlledPublicationService';
import {
  assertPublicationExecutionTarget,
  type PublicationExecutionTarget,
} from './publicationExecutionPolicy';

export function createControlledPublicationDependencies(params: {
  supabase: SupabaseClient;
  supabaseUrl: string;
  publicId: string;
  adminId: string;
  privateBucket: string;
  publicFeedBucket: string;
  publicFeedPath: string;
  executionTarget: PublicationExecutionTarget;
}): ControlledPublicationDependencies {
  const {
    supabase,
    supabaseUrl,
    publicId,
    adminId,
    privateBucket,
    publicFeedBucket,
    publicFeedPath,
    executionTarget,
  } = params;
  const projects = new SupabaseProjectRepositoryCore(supabase);
  const previews = new SupabaseParticipantPreviewRepositoryCore(supabase);
  const publication = new SupabasePublicationExecutionRepositoryCore(supabase, supabaseUrl);
  const feedPublicUrl = publication.getPublicUrl(publicFeedBucket, publicFeedPath);
  return {
    assertExecutionEnvironment: () => assertPublicationExecutionTarget({
      target: executionTarget,
      supabaseUrl,
    }),
    getReadiness: () => previews.getPublicationReadiness({ publicId, adminId, privateBucket }),
    listProjects: () => projects.listProjects(),
    listProjectMedia: () => publication.listProjectMedia(publicId),
    getCompletedAttempt: () => publication.getCompletedAttempt(publicId),
    getRecoverableAttempt: () => publication.getRecoverableAttempt(publicId),
    getPublishedSnapshot: (snapshotId) => publication.getPublishedSnapshot(snapshotId),
    getPublishAuditRecord: (auditRecordId) => publication.getPublishAuditRecord(auditRecordId),
    getPublicUrl: (bucket, path) => publication.getPublicUrl(bucket, path),
    reserveAttempt: (confirmedPreviewId, confirmedAt) => publication.reserveAttempt({
      publicId,
      adminId,
      privateBucket,
      confirmedPreviewId,
      confirmedAt,
    }),
    prepareAttempt: (attemptId, executionToken, plan, mediaManifest, previousFeedContent) => publication.prepareAttempt({
      attemptId,
      executionToken,
      privateBucket,
      recordCount: plan.recordCount,
      feedHash: plan.feedHash,
      content: plan.content,
      feedBucket: publicFeedBucket,
      feedPath: publicFeedPath,
      feedPublicUrl,
      previousFeedContent,
      mediaManifest,
    }),
    claimAttempt: () => publication.claimAttempt(publicId, adminId),
    markStorageWritten: (attemptId, executionToken, feedHash, recordCount) => publication.markStorageWritten(attemptId, executionToken, feedHash, recordCount),
    finalizeAttempt: (attemptId, executionToken) => publication.finalizeAttempt(attemptId, executionToken, privateBucket),
    failAttempt: (attemptId, executionToken, failureCode, compensationFailureCode) => publication.failAttempt(attemptId, executionToken, failureCode, compensationFailureCode),
    downloadObject: (bucket, path) => publication.downloadObject(bucket, path),
    uploadNewObject: (bucket, path, content, contentType) => publication.uploadNewObject(bucket, path, content, contentType),
    overwriteObject: (bucket, path, content, contentType) => publication.overwriteObject(bucket, path, content, contentType),
    removeObjects: (bucket, paths) => publication.removeObjects(bucket, paths),
  };
}
