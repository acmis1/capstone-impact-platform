import { SupabaseClient } from '@supabase/supabase-js';
import { Project } from '../domain/project';
import { ProjectRepository } from './ProjectRepository';

export class SupabaseProjectRepositoryCore implements ProjectRepository {
  constructor(protected readonly supabase: SupabaseClient) {}

  protected mapDbToDomain(row: any): Project {
    const joinedDisciplines = row.project_disciplines?.map((pd: any) => pd.disciplines?.name).filter(Boolean) || [];
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
      layoutConfig: row.layout_config || {},
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

  protected mapDomainToDb(proj: Partial<Project>): any {
    const row: any = {};
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

    return (data || []).map((row) => this.mapDbToDomain(row));
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

    return data ? this.mapDbToDomain(data) : null;
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

    return this.mapDbToDomain(data);
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

    return this.mapDbToDomain(data);
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
    // Dynamic import to prevent dependency cycles if any
    const { applyReviewActionTransition } = require('../workflow/projectWorkflow');
    const transition = applyReviewActionTransition(dbProject.status, action);

    if (!transition.allowed || !transition.toStatus) {
      throw new Error(`Staging transition invalid: ${transition.error || 'Disallowed status change'}`);
    }

    const fromStatus = dbProject.status;
    const toStatus = transition.toStatus;

    // 3. Compose status updates
    const updates: any = {
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
      // Log the warning, but do not fail the request completely since database status was successfully updated
      console.warn(`[Staging Audit Logging Warning]: Failed to insert audit row: ${auditError.message}`);
    }

    return this.mapDbToDomain(updatedProjectRow);
  }
}
