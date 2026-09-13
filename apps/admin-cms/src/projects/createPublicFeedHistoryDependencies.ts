import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminPermission } from '../auth/authTypes';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { SupabasePublicationExecutionRepositoryCore } from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { promoteBoundPublicMedia } from './boundPublicMediaPromotion';
import {
  assertPublicationExecutionTarget,
  type PublicationExecutionTarget,
} from './publicationExecutionPolicy';
import type { PublicFeedHistoryServiceDependencies } from './publicFeedHistoryService';

export function createPublicFeedHistoryDependencies(params: {
  supabase: SupabaseClient;
  supabaseUrl: string;
  adminId: string;
  permissions: AdminPermission[];
  feedBucket: string;
  feedPath: string;
  /**
   * Required by activation and forward recovery. Existing rollback routes omit it because the
   * history service applies their separate rollback-capability policy before this assertion.
   */
  executionTarget?: PublicationExecutionTarget;
  environment?: Record<string, string | undefined>;
}): PublicFeedHistoryServiceDependencies {
  const projects = new SupabaseProjectRepositoryCore(params.supabase);
  const publication = new SupabasePublicationExecutionRepositoryCore(params.supabase, params.supabaseUrl);
  return {
    supabase: params.supabase, supabaseUrl: params.supabaseUrl, adminId: params.adminId,
    permissions: params.permissions, feedBucket: params.feedBucket, feedPath: params.feedPath,
    environment: params.environment,
    listProjects: () => projects.listProjects(),
    promoteBoundPublicMedia: (manifest) => promoteBoundPublicMedia({
      downloadObject: (bucket, path) => publication.downloadObject(bucket, path),
      uploadNewObject: (bucket, path, content, contentType) =>
        publication.uploadNewObject(bucket, path, content, contentType),
    }, manifest),
    assertActivationEnvironment: () => {
      try {
        if (!params.executionTarget) throw new Error('EXECUTION_TARGET_REQUIRED');
        assertPublicationExecutionTarget({
          target: params.executionTarget,
          supabaseUrl: params.supabaseUrl,
          env: params.environment,
        });
      } catch {
        throw new Error('EXECUTION_POLICY_DENIED');
      }
    },
  };
}
