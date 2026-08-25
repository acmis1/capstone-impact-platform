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
    executionTarget,
  } = params;
  const projects = new SupabaseProjectRepositoryCore(supabase);
  const previews = new SupabaseParticipantPreviewRepositoryCore(supabase);
  const publication = new SupabasePublicationExecutionRepositoryCore(supabase, supabaseUrl);
  return {
    supabase,
    adminId,
    assertExecutionEnvironment: () => assertPublicationExecutionTarget({
      target: executionTarget,
      supabaseUrl,
    }),
    getReadiness: () => previews.getPublicationReadiness({ publicId, adminId, privateBucket }),
    getReconciliationReadiness: () => previews.getReconciliationReadiness({ publicId, adminId, privateBucket }),
    listProjects: () => projects.listProjects(),
    listProjectMedia: () => publication.listProjectMedia(publicId),
    getPublicUrl: (bucket, path) => publication.getPublicUrl(bucket, path),
    downloadObject: (bucket, path) => publication.downloadObject(bucket, path),
    uploadNewObject: (bucket, path, content, contentType) => publication.uploadNewObject(bucket, path, content, contentType),
  };
}
