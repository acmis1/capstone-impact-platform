import { SupabaseClient } from '@supabase/supabase-js';

export interface ImportBatchRow {
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

export interface ImportedProjectRow {
  id: string;
  public_id: string;
  title: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface ValidationFlagRow {
  id: string;
  project_id: string;
  severity: string;
  rule_code: string;
  field_name?: string | null;
  message: string;
  is_resolved?: boolean;
}

export interface MediaAssetRow {
  id: string;
  project_id: string;
  file_name: string;
  asset_type: string;
  storage_bucket: string;
  storage_path: string;
  is_public_approved?: boolean;
  public_url?: string | null;
}

export interface ImportBatchReviewValidationFlagRow {
  severity: string;
  resolved: boolean | null;
  message: string;
}

export interface ImportBatchReviewProjectRow {
  id: string;
  public_id: string;
  title: string | null;
  summary: string | null;
  status: string;
  program_id: string | null;
  program_name: string | null;
  study_program: string | null;
  discipline: string | null;
  group_name: string | null;
  team_members: string[] | null;
  accessibility_text_public: string | null;
  snapshots: string[] | null;
  validation_errors: string[] | null;
  validation_warnings: string[] | null;
  project_disciplines?: Array<{ discipline_id: string }>;
  project_industry_categories?: Array<{ industry_category_id: string }>;
  media_assets?: Array<{ asset_type: string; is_public_approved: boolean | null; public_url: string | null }>;
  validation_flags?: ImportBatchReviewValidationFlagRow[];
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

  async getImportedProjectsForBatch(batchId: string): Promise<ImportedProjectRow[]> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*')
      .eq('import_batch_id', batchId)
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to get imported projects for batch [${batchId}]: ${error.message}`);
    }
    return (data as ImportedProjectRow[]) || [];
  }

  async getValidationFlagsForProject(projectId: string): Promise<ValidationFlagRow[]> {
    const { data, error } = await this.supabase
      .from('validation_flags')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get validation flags for project [${projectId}]: ${error.message}`);
    }
    return (data as ValidationFlagRow[]) || [];
  }

  async getMediaAssetsForProject(projectId: string): Promise<MediaAssetRow[]> {
    const { data, error } = await this.supabase
      .from('media_assets')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to get media assets for project [${projectId}]: ${error.message}`);
    }
    return (data as MediaAssetRow[]) || [];
  }

  /**
   * Fetches every non-deleted project in a batch along with the relational/media data required
   * to derive server-authoritative review readiness (see importBatchReviewReadiness.ts).
   * Read-only: used purely for UI display, never as the authority for the submission RPC itself.
   */
  async getImportBatchReviewData(batchId: string): Promise<ImportBatchReviewProjectRow[]> {
    const { data, error } = await this.supabase
      .from('projects')
      .select(
        `id, public_id, title, summary, status, program_id, program_name, study_program,
         discipline, group_name, team_members, accessibility_text_public, snapshots,
         validation_errors, validation_warnings,
         project_disciplines(discipline_id),
         project_industry_categories(industry_category_id),
         media_assets(asset_type, is_public_approved, public_url),
         validation_flags(severity, resolved, message)`
      )
      .eq('import_batch_id', batchId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to get import batch review data [${batchId}]: ${error.message}`);
    }
    return (data as unknown as ImportBatchReviewProjectRow[]) || [];
  }

  /**
   * Single-project variant of getImportBatchReviewData, for the project detail page's
   * "Submit for review" action. Read-only; same caveat applies.
   */
  async getProjectReviewDataByPublicId(publicId: string): Promise<ImportBatchReviewProjectRow | null> {
    const { data, error } = await this.supabase
      .from('projects')
      .select(
        `id, public_id, title, summary, status, program_id, program_name, study_program,
         discipline, group_name, team_members, accessibility_text_public, snapshots,
         validation_errors, validation_warnings,
         project_disciplines(discipline_id),
         project_industry_categories(industry_category_id),
         media_assets(asset_type, is_public_approved, public_url),
         validation_flags(severity, resolved, message)`
      )
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get project review data [${publicId}]: ${error.message}`);
    }
    return (data as unknown as ImportBatchReviewProjectRow) || null;
  }
}
