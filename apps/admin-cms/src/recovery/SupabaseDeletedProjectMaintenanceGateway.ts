import 'server-only';
import { parseDeletedProjectListResponse, parseDeletedProjectDetailResponse, parseDeletedProjectRecoveryResponse } from './deletedProjectMaintenanceResponses';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  DeletedProjectDetail,
  DeletedProjectList,
  DeletedProjectMaintenanceGateway,
} from './deletedProjectMaintenance';

export class SupabaseDeletedProjectMaintenanceGateway implements DeletedProjectMaintenanceGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(input: Parameters<DeletedProjectMaintenanceGateway['list']>[0]): Promise<DeletedProjectList> {
    const { data, error } = await this.supabase.rpc('list_deleted_projects', {
      p_admin_id: input.adminId, p_page: input.page, p_page_size: input.pageSize, p_search: input.search ?? null,
    });
    if (error) throw new Error('Deleted project list failed.');
    return parseDeletedProjectListResponse(data, input.page, input.pageSize);
  }

  async detail(publicId: string, adminId: string): Promise<DeletedProjectDetail | null> {
    const { data, error } = await this.supabase.rpc('get_deleted_project_detail', { p_public_id: publicId, p_admin_id: adminId });
    if (error) throw new Error('Deleted project detail failed.');
    return parseDeletedProjectDetailResponse(data, publicId);
  }

  async recover(input: Parameters<DeletedProjectMaintenanceGateway['recover']>[0]): Promise<Record<string, unknown>> {
    const { data, error } = await this.supabase.rpc('recover_deleted_project_if_current', {
      p_public_id: input.publicId, p_expected_updated_at: input.expectedUpdatedAt,
      p_expected_deleted_at: input.expectedDeletedAt, p_admin_id: input.adminId,
    });
    if (error) throw new Error('Deleted project recovery failed.');
    return parseDeletedProjectRecoveryResponse(data, input.publicId);
  }
}
