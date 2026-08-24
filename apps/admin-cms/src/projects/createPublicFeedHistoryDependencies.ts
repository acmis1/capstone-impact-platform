import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminPermission } from '../auth/authTypes';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { isLocalPublicationExecutionAvailable } from './localPublicationExecution';
import { isStagingPublicationExecutionAvailable } from './publicationExecutionPolicy';
import type { PublicFeedHistoryServiceDependencies } from './publicFeedHistoryService';

export function createPublicFeedHistoryDependencies(params: {
  supabase: SupabaseClient;
  supabaseUrl: string;
  adminId: string;
  permissions: AdminPermission[];
  feedBucket: string;
  feedPath: string;
  environment?: Record<string, string | undefined>;
}): PublicFeedHistoryServiceDependencies {
  const projects = new SupabaseProjectRepositoryCore(params.supabase);
  return {
    supabase: params.supabase, supabaseUrl: params.supabaseUrl, adminId: params.adminId,
    permissions: params.permissions, feedBucket: params.feedBucket, feedPath: params.feedPath,
    environment: params.environment,
    listProjects: () => projects.listProjects(),
    assertActivationEnvironment: () => {
      if (!isLocalPublicationExecutionAvailable(params.supabaseUrl)
          && !isStagingPublicationExecutionAvailable(params.supabaseUrl, params.environment)) {
        throw new Error('EXECUTION_POLICY_DENIED');
      }
    },
  };
}
