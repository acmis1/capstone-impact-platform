import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import type { ControlledPublicRemovalDependencies } from './controlledPublicRemovalService';
import {
  assertPublicationExecutionTarget,
  type PublicationExecutionTarget,
} from './publicationExecutionPolicy';

export function createControlledPublicRemovalDependencies(params: {
  supabase: SupabaseClient;
  supabaseUrl: string;
  publicId: string;
  adminId: string;
  feedBucket: string;
  feedPath: string;
  executionTarget: PublicationExecutionTarget;
}): ControlledPublicRemovalDependencies {
  const projects = new SupabaseProjectRepositoryCore(params.supabase);
  return {
    supabase: params.supabase,
    adminId: params.adminId,
    feedBucket: params.feedBucket,
    feedPath: params.feedPath,
    assertExecutionEnvironment: () => assertPublicationExecutionTarget({
      target: params.executionTarget,
      supabaseUrl: params.supabaseUrl,
    }),
    listProjects: () => projects.listProjects(),
  };
}
