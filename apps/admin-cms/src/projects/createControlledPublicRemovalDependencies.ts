import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import type { ControlledPublicRemovalDependencies } from './controlledPublicRemovalService';
import { isLocalPublicationExecutionAvailable } from './localPublicationExecution';

export function createControlledPublicRemovalDependencies(params: {
  supabase: SupabaseClient;
  supabaseUrl: string;
  publicId: string;
  adminId: string;
  feedBucket: string;
  feedPath: string;
}): ControlledPublicRemovalDependencies {
  const projects = new SupabaseProjectRepositoryCore(params.supabase);
  return {
    supabase: params.supabase,
    adminId: params.adminId,
    feedBucket: params.feedBucket,
    feedPath: params.feedPath,
    assertDisposableLocalEnvironment: () => {
      if (!isLocalPublicationExecutionAvailable(params.supabaseUrl)) {
        throw new Error('NON_LOCAL_ENVIRONMENT');
      }
    },
    listProjects: () => projects.listProjects(),
  };
}
