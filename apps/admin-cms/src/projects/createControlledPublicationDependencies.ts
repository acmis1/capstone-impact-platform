import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { SupabasePublicationExecutionRepositoryCore } from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { ControlledPublicationDependencies } from './controlledPublicationService';

export function createControlledPublicationDependencies(params: {
  supabase: SupabaseClient;
  supabaseUrl: string;
  publicId: string;
  adminId: string;
  privateBucket: string;
  publicFeedBucket: string;
  publicFeedPath: string;
}): ControlledPublicationDependencies {
  const { supabase, supabaseUrl, publicId, adminId, privateBucket, publicFeedBucket, publicFeedPath } = params;
  const projects = new SupabaseProjectRepositoryCore(supabase);
  const previews = new SupabaseParticipantPreviewRepositoryCore(supabase);
  const publication = new SupabasePublicationExecutionRepositoryCore(supabase, supabaseUrl);
  const feedPublicUrl = publication.getPublicUrl(publicFeedBucket, publicFeedPath);
  return {
    assertDisposableLocalEnvironment: () => publication.assertDisposableLocalEnvironment(),
    getReadiness: () => previews.getPublicationReadiness({ publicId, adminId, privateBucket }),
    listProjects: () => projects.listProjects(),
    listProjectMedia: () => publication.listProjectMedia(publicId),
    getLatestAttempt: () => publication.getLatestAttempt(publicId),
    getPublicUrl: (bucket, path) => publication.getPublicUrl(bucket, path),
    beginAttempt: (plan, previousFeedContent, confirmedPreviewId, confirmedAt) => publication.beginAttempt({
      publicId,
      adminId,
      privateBucket,
      confirmedPreviewId,
      confirmedAt,
      recordCount: plan.recordCount,
      feedHash: plan.feedHash,
      content: plan.content,
      feedBucket: publicFeedBucket,
      feedPath: publicFeedPath,
      feedPublicUrl,
      previousFeedContent,
      mediaManifest: plan.mediaPromotions,
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
