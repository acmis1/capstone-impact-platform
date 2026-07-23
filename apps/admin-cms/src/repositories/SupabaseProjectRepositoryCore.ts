import { SupabaseClient } from '@supabase/supabase-js';
import { Project } from '../domain/project';
import {
  ProjectListQuery,
  ProjectListResult,
  ProjectDashboardMetrics,
  normalizeSearchInput,
} from '../domain/projectQuery';
import { ProjectRepository } from './ProjectRepository';
import { applyReviewActionTransition } from '../workflow/projectWorkflow';

export interface DatabaseProjectRow {
  id: string;
  public_id: string;
  title?: string;
  summary?: string;
  background?: string;
  solution?: string;
  year?: number;
  program_name?: string;
  study_program?: string;
  discipline?: string;
  industry?: string;
  industry_partner?: string;
  academic_supervisor?: string;
  group_name?: string;
  team_members?: string[];
  poster_url?: string;
  poster_pdf_url?: string;
  poster_text_public?: string;
  accessibility_text_public?: string;
  snapshots?: string[];
  video_url?: string;
  demo_url?: string;
  repository_url?: string;
  external_links?: Project['externalLinks'];
  citations?: string[];
  layout_config?: Project['layoutConfig'];
  status?: Project['status'];
  import_batch_id?: string;
  source_folder?: string;
  internal_staff_notes?: string;
  private_review_comments?: string;
  validation_flags_cache?: Project['validationFlags'];
  validation_errors?: string[];
  validation_warnings?: string[];
  pending_removal_from_public?: boolean;
  public_removal_completed_at?: string;
  archived_at?: string;
  archived_from_status?: Project['status'];
  archive_reason?: string;
  created_at?: string;
  updated_at?: string;
  project_disciplines?: Array<{
    disciplines?: {
      name?: string;
    };
  }>;
}

export class SupabaseProjectRepositoryCore implements ProjectRepository {
  constructor(protected readonly supabase: SupabaseClient) {}

  protected mapDbToDomain(row: DatabaseProjectRow): Project {
    const joinedDisciplines = row.project_disciplines?.map((pd) => pd.disciplines?.name).filter(Boolean) as string[] || [];
    const finalDisciplines = joinedDisciplines.length > 0 
      ? joinedDisciplines 
      : (row.discipline ? [row.discipline] : []);

    return {
      id: this.hashStringToNumber(row.public_id),
      publicId: row.public_id,
      title: row.title || '',
      summary: row.summary || '',
      background: row.background || '',
      solution: row.solution || '',
      year: row.year ? row.year.toString() : '',
      program: row.program_name || '',
      studyProgram: row.study_program || '',
      discipline: row.discipline || '',
      disciplines: finalDisciplines,
      industry: row.industry || '',
      industryPartner: row.industry_partner || '',
      academicSupervisor: row.academic_supervisor || '',
      groupName: row.group_name || '',
      teamMembers: row.team_members || [],
      poster: row.poster_url || '',
      posterPdf: row.poster_pdf_url || '',
      posterText: row.poster_text_public || '',
      accessibilityText: row.accessibility_text_public || '',
      snapshots: row.snapshots || [],
      videoUrl: row.video_url || '',
      demoUrl: row.demo_url || '',
      repositoryUrl: row.repository_url || '',
      externalLinks: row.external_links || [],
      citations: row.citations || [],
      layoutConfig: row.layout_config || ({} as Project['layoutConfig']),
      status: row.status || 'draft',
      importBatchId: row.import_batch_id || undefined,
      sourceFolder: row.source_folder || undefined,
      internalStaffNotes: row.internal_staff_notes || undefined,
      privateReviewComments: row.private_review_comments || undefined,
      validationFlags: row.validation_flags_cache || undefined,
      validationErrors: row.validation_errors || [],
      validationWarnings: row.validation_warnings || [],
      pendingRemovalFromPublic: row.pending_removal_from_public || false,
      publicRemovalCompletedAt: row.public_removal_completed_at || undefined,
      archivedAt: row.archived_at || undefined,
      archivedFromStatus: row.archived_from_status || undefined,
      archiveReason: row.archive_reason || undefined,
      created_at: row.created_at || undefined,
      updated_at: row.updated_at || undefined
    };
  }

  protected mapDomainToDb(proj: Partial<Project>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (proj.publicId !== undefined) row.public_id = proj.publicId;
    if (proj.title !== undefined) row.title = proj.title;
    if (proj.summary !== undefined) row.summary = proj.summary;
    if (proj.background !== undefined) row.background = proj.background;
    if (proj.solution !== undefined) row.solution = proj.solution;
    if (proj.year !== undefined) row.year = parseInt(proj.year, 10);
    if (proj.program !== undefined) row.program_name = proj.program;
    if (proj.studyProgram !== undefined) row.study_program = proj.studyProgram;
    if (proj.discipline !== undefined) row.discipline = proj.discipline;
    if (proj.industry !== undefined) row.industry = proj.industry;
    if (proj.industryPartner !== undefined) row.industry_partner = proj.industryPartner;
    if (proj.academicSupervisor !== undefined) row.academic_supervisor = proj.academicSupervisor;
    if (proj.groupName !== undefined) row.group_name = proj.groupName;
    if (proj.teamMembers !== undefined) row.team_members = proj.teamMembers;
    if (proj.poster !== undefined) row.poster_url = proj.poster;
    if (proj.posterPdf !== undefined) row.poster_pdf_url = proj.posterPdf;
    if (proj.posterText !== undefined) row.poster_text_public = proj.posterText;
    if (proj.accessibilityText !== undefined) row.accessibility_text_public = proj.accessibilityText;
    if (proj.snapshots !== undefined) row.snapshots = proj.snapshots;
    if (proj.videoUrl !== undefined) row.video_url = proj.videoUrl;
    if (proj.demoUrl !== undefined) row.demo_url = proj.demoUrl;
    if (proj.repositoryUrl !== undefined) row.repository_url = proj.repositoryUrl;
    if (proj.externalLinks !== undefined) row.external_links = proj.externalLinks;
    if (proj.citations !== undefined) row.citations = proj.citations;
    if (proj.layoutConfig !== undefined) row.layout_config = proj.layoutConfig;
    if (proj.status !== undefined) row.status = proj.status;
    if (proj.importBatchId !== undefined) row.import_batch_id = proj.importBatchId;
    if (proj.sourceFolder !== undefined) row.source_folder = proj.sourceFolder;
    if (proj.internalStaffNotes !== undefined) row.internal_staff_notes = proj.internalStaffNotes;
    if (proj.privateReviewComments !== undefined) row.private_review_comments = proj.privateReviewComments;
    if (proj.validationFlags !== undefined) row.validation_flags_cache = proj.validationFlags;
    if (proj.validationErrors !== undefined) row.validation_errors = proj.validationErrors;
    if (proj.validationWarnings !== undefined) row.validation_warnings = proj.validationWarnings;
    if (proj.pendingRemovalFromPublic !== undefined) row.pending_removal_from_public = proj.pendingRemovalFromPublic;
    if (proj.publicRemovalCompletedAt !== undefined) row.public_removal_completed_at = proj.publicRemovalCompletedAt;
    if (proj.archivedAt !== undefined) row.archived_at = proj.archivedAt;
    if (proj.archivedFromStatus !== undefined) row.archived_from_status = proj.archivedFromStatus;
    if (proj.archiveReason !== undefined) row.archive_reason = proj.archiveReason;
    return row;
  }

  protected hashStringToNumber(str: string): number {
    if (!str) return 0;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash) % 2147483647;
  }

  async listProjects(): Promise<Project[]> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*, project_disciplines(disciplines(name))')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list projects from Supabase: ${error.message}`);
    }

    return (data || []).map((row: DatabaseProjectRow) => this.mapDbToDomain(row));
  }

  async listProjectsPage(query: ProjectListQuery): Promise<ProjectListResult> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && [10, 25, 50].includes(query.pageSize) ? query.pageSize : 10;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let dbQuery = this.supabase
      .from('projects')
      .select('*, project_disciplines(disciplines(name))', { count: 'exact' })
      .is('deleted_at', null);

    // Apply search
    if (query.search) {
      const sanitized = normalizeSearchInput(query.search);
      if (sanitized) {
        dbQuery = dbQuery.or(
          `title.ilike.%${sanitized}%,public_id.ilike.%${sanitized}%,industry_partner.ilike.%${sanitized}%,group_name.ilike.%${sanitized}%`
        );
      }
    }

    // Apply status filter
    if (query.status) {
      dbQuery = dbQuery.eq('status', query.status);
    }

    // Apply year filter
    if (query.year) {
      const parsedYear = parseInt(query.year, 10);
      if (!isNaN(parsedYear)) {
        dbQuery = dbQuery.eq('year', parsedYear);
      }
    }

    // Apply program filter
    if (query.program) {
      dbQuery = dbQuery.eq('program_name', query.program);
    }

    // Apply discipline filter
    if (query.discipline) {
      dbQuery = dbQuery.eq('discipline', query.discipline);
    }

    // Apply sort
    const allowedSortFieldsMap: Record<string, string> = {
      created_at: 'created_at',
      updated_at: 'updated_at',
      title: 'title',
      year: 'year',
      status: 'status',
    };
    const sortColumn = allowedSortFieldsMap[query.sort || 'created_at'] || 'created_at';
    const isAscending = query.direction === 'asc';

    dbQuery = dbQuery.order(sortColumn, { ascending: isAscending }).range(from, to);

    const { data, count, error } = await dbQuery;

    if (error) {
      throw new Error(`Failed to query paginated projects from Supabase: ${error.message}`);
    }

    const total = count ?? 0;
    const pageCount = total > 0 ? Math.ceil(total / pageSize) : 0;
    const projects = (data || []).map((row: DatabaseProjectRow) => this.mapDbToDomain(row));

    return {
      projects,
      total,
      page,
      pageSize,
      pageCount,
    };
  }

  async getProjectDashboardMetrics(): Promise<ProjectDashboardMetrics> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('status')
      .is('deleted_at', null);

    if (error) {
      throw new Error(`Failed to fetch project dashboard metrics: ${error.message}`);
    }

    const rows = data || [];
    const totalProjects = rows.length;
    let publicEligible = 0;
    let inReview = 0;
    let archived = 0;

    for (const row of rows) {
      const status = row.status;
      if (status === 'approved' || status === 'published') {
        publicEligible++;
      } else if (status === 'submitted' || status === 'in_review') {
        inReview++;
      } else if (status === 'archived') {
        archived++;
      }
    }

    return {
      totalProjects,
      publicEligible,
      inReview,
      archived,
    };
  }

  async getProjectByPublicId(publicId: string): Promise<Project | null> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*, project_disciplines(disciplines(name))')
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get project by public ID: ${error.message}`);
    }

    return data ? this.mapDbToDomain(data as DatabaseProjectRow) : null;
  }

  async createProject(input: Partial<Project> & { title: string; year: string; publicId: string }): Promise<Project> {
    const dbRow = this.mapDomainToDb(input);
    dbRow.public_id = input.publicId;

    const { data, error } = await this.supabase
      .from('projects')
      .insert(dbRow)
      .select('*, project_disciplines(disciplines(name))')
      .single();

    if (error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }

    return this.mapDbToDomain(data as DatabaseProjectRow);
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    const dbRow = this.mapDomainToDb(patch);

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const query = this.supabase.from('projects').update(dbRow);
    const filterQuery = isUuid ? query.eq('id', id) : query.eq('public_id', id);

    const { data, error } = await filterQuery
      .select('*, project_disciplines(disciplines(name))')
      .single();

    if (error) {
      throw new Error(`Failed to update project: ${error.message}`);
    }

    return this.mapDbToDomain(data as DatabaseProjectRow);
  }

  async archiveProject(id: string, reason: string): Promise<Project> {
    const patch: Partial<Project> = {
      status: 'archived',
      archivedAt: new Date().toISOString(),
      archiveReason: reason,
      pendingRemovalFromPublic: true
    };
    return this.updateProject(id, patch);
  }

  async softDeleteProject(id: string): Promise<void> {
    const patch = {
      status: 'deleted' as const,
      deleted_at: new Date().toISOString()
    };
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const query = this.supabase.from('projects').update(patch);
    const filterQuery = isUuid ? query.eq('id', id) : query.eq('public_id', id);

    const { error } = await filterQuery;
    if (error) {
      throw new Error(`Failed to soft-delete project: ${error.message}`);
    }
  }

  async performReviewAction(params: {
    publicId: string;
    action: 'request_changes' | 'approve' | 'archive';
    comments?: string;
    adminId?: string | null;
  }): Promise<Project> {
    const { publicId, action, comments, adminId } = params;

    // 1. Fetch current project state
    const { data: dbProject, error: fetchError } = await this.supabase
      .from('projects')
      .select('*')
      .eq('public_id', publicId)
      .maybeSingle();

    if (fetchError || !dbProject) {
      throw new Error(`Failed to find target staging project [${publicId}] for review: ${fetchError?.message || 'Not Found'}`);
    }

    // 2. Validate transition
    const transition = applyReviewActionTransition(dbProject.status, action);

    if (!transition.allowed || !transition.toStatus) {
      throw new Error(`Staging transition invalid: ${transition.error || 'Disallowed status change'}`);
    }

    const fromStatus = dbProject.status;
    const toStatus = transition.toStatus;

    // 3. Compose status updates
    const updates: Record<string, unknown> = {
      status: toStatus
    };

    if (action === 'archive') {
      updates.archived_at = new Date().toISOString();
      updates.archived_from_status = fromStatus;
      updates.archive_reason = comments || 'Archived under standard review workflow';
      updates.pending_removal_from_public = true;
    } else if (action === 'approve') {
      // Clear archival info if approved again
      updates.archived_at = null;
      updates.archived_from_status = null;
      updates.archive_reason = null;
    }

    // 4. Perform database update
    const { data: updatedProjectRow, error: updateError } = await this.supabase
      .from('projects')
      .update(updates)
      .eq('id', dbProject.id)
      .select('*, project_disciplines(disciplines(name))')
      .single();

    if (updateError || !updatedProjectRow) {
      throw new Error(`Failed to update project status in staging: ${updateError?.message || 'Returned row is null'}`);
    }

    // 5. Insert audit log inside approval_records
    const auditRow = {
      project_id: dbProject.id,
      admin_id: adminId || null,
      action_taken: action,
      from_status: fromStatus,
      to_status: toStatus,
      comments: comments || null
    };

    const { error: auditError } = await this.supabase
      .from('approval_records')
      .insert(auditRow);

    if (auditError) {
      throw new Error(`Project status update completed but audit logging failed; staging data may require manual reset. Details: ${auditError.message}`);
    }

    return this.mapDbToDomain(updatedProjectRow as DatabaseProjectRow);
  }
}
