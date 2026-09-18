import 'server-only';
import { parseProjectLayoutMaintenanceResponse } from './projectLayoutMaintenanceResponse';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectLayoutMaintenanceGateway, ProjectLayoutMaintenanceResult } from './projectLayoutMaintenance';

export class SupabaseProjectLayoutMaintenanceGateway implements ProjectLayoutMaintenanceGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async update(input: Parameters<ProjectLayoutMaintenanceGateway['update']>[0]): Promise<ProjectLayoutMaintenanceResult> {
    const { data, error } = await this.supabase.rpc('update_project_layout_if_current', {
      p_public_id: input.publicId,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_layout_config: input.layoutConfig,
      p_recipe_version_id: input.recipeVersionId,
      p_admin_id: input.adminId,
    });
    if (error) throw new Error('Project layout maintenance failed.');
    return parseProjectLayoutMaintenanceResponse(data, input.publicId);
  }
}
