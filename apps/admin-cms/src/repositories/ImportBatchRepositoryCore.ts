import { SupabaseClient } from '@supabase/supabase-js';

export interface ImportBatchRow extends Record<string, unknown> {
  id: string;
  batch_name: string;
  source_folder: string;
  mode: string;
  status: string;
  total_projects: number;
  error_count: number;
  warning_count: number;
  created_at: string;
}

export class ImportBatchRepositoryCore {
  constructor(protected readonly supabase: SupabaseClient) {}

  async listRecentImportBatches(limit: number = 20): Promise<ImportBatchRow[]> {
    const { data, error } = await this.supabase
      .from('import_batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to list recent import batches: ${error.message}`);
    }
    return (data as ImportBatchRow[]) || [];
  }

  async getImportBatchById(batchId: string): Promise<ImportBatchRow | null> {
    const { data, error } = await this.supabase
      .from('import_batches')
      .select('*')
      .eq('id', batchId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get import batch by ID [${batchId}]: ${error.message}`);
    }
    return data as ImportBatchRow | null;
  }

  async getImportedProjectsForBatch(batchId: string): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*')
      .eq('import_batch_id', batchId)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to get imported projects for batch [${batchId}]: ${error.message}`);
    }
    return (data as Array<Record<string, unknown>>) || [];
  }

  async getValidationFlagsForProject(projectId: string): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.supabase
      .from('validation_flags')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get validation flags for project [${projectId}]: ${error.message}`);
    }
    return (data as Array<Record<string, unknown>>) || [];
  }

  async getMediaAssetsForProject(projectId: string): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.supabase
      .from('media_assets')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get media assets for project [${projectId}]: ${error.message}`);
    }
    return (data as Array<Record<string, unknown>>) || [];
  }
}
