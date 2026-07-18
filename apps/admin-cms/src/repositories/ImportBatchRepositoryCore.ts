import { SupabaseClient } from '@supabase/supabase-js';

export class ImportBatchRepositoryCore {
  constructor(protected readonly supabase: SupabaseClient) {}

  async listRecentImportBatches(limit: number = 20): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('import_batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to list recent import batches: ${error.message}`);
    }
    return data || [];
  }

  async getImportBatchById(batchId: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from('import_batches')
      .select('*')
      .eq('id', batchId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get import batch by ID [${batchId}]: ${error.message}`);
    }
    return data;
  }

  async getImportedProjectsForBatch(batchId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*')
      .eq('import_batch_id', batchId)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to get imported projects for batch [${batchId}]: ${error.message}`);
    }
    return data || [];
  }

  async getValidationFlagsForProject(projectId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('validation_flags')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get validation flags for project [${projectId}]: ${error.message}`);
    }
    return data || [];
  }

  async getMediaAssetsForProject(projectId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('media_assets')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get media assets for project [${projectId}]: ${error.message}`);
    }
    return data || [];
  }
}
