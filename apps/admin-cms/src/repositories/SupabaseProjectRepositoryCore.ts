import { SupabaseClient } from '@supabase/supabase-js';
import { Project } from '../domain/project';
import {
  ProjectListQuery,
  ProjectListResult,
  ProjectDashboardMetrics,
  ProjectFilterOptions,
  normalizeSearchInput,
} from '../domain/projectQuery';
import {
  ProjectRepository,
  ReviewActionExecutionError,
  ReviewActionExecutionErrorCode,
} from './ProjectRepository';

/**
 * Project row plus the related rows the domain mapping needs. The snapshot media join supplies the
 * text alternative for each public snapshot URL; only public columns are selected, so no private
 * bucket or draft path is ever read into a project the feed is compiled from.
 */
const PROJECT_WITH_RELATIONS_SELECT =
  '*, project_disciplines(disciplines(name)), media_assets(asset_type,gallery_position,public_url,alt_text_public,is_public_approved)';

/** Maximum number of lightweight filter-option rows fetched per database round-trip. */
const PROJECT_FILTER_OPTION_CHUNK_SIZE = 500;
/** Safety limit to prevent an infinite pagination loop for filter options. */
const PROJECT_FILTER_OPTION_MAX_ITERATIONS = 200;

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
  participant_contact_email?: string | null;
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
  /**
   * Joined snapshot media, present only on the queries that request it. Publication writes
   * `projects.snapshots` and the corresponding `media_assets` public columns in one transaction, so
   * these rows are the authoritative source of each public snapshot URL's text alternative.
   */
  media_assets?: Array<{
    asset_type?: string;
    gallery_position: number | null;
    public_url?: string | null;
    alt_text_public?: string | null;
    is_public_approved?: boolean | null;
  }>;
}

/**
 * Pairs each public snapshot URL on the project row with the alt text stored on the media asset
 * that owns it, matching on the public URL itself rather than on array position.
 *
 * Only public, approved snapshot rows can contribute, so nothing private is ever surfaced. A URL
 * with no matching media row, or a matching row with no alt text, is deliberately left out rather
 * than emitted with a fabricated description — the feed validator then reports that snapshot as
 * published without a text alternative instead of the record passing silently.
 */
function mapSnapshotMedia(row: DatabaseProjectRow): Project['snapshotMedia'] {
  const snapshots = row.snapshots || [];

  if (snapshots.length === 0 || !Array.isArray(row.media_assets)) {
    return [];
  }

  const mediaByUrl = new Map<
    string,
    {
      altText: string;
      galleryPosition: number;
    }
  >();

  // Count public-approved snapshot URL claims before validating any claimant's descriptive data.
  // A malformed claimant must not disappear early and let another row silently become the unique
  // authority for the same URL.
  const claimCountByUrl = new Map<string, number>();
  for (const asset of row.media_assets) {
    if (asset.asset_type !== 'snapshot_image' || asset.is_public_approved !== true) continue;
    const url = typeof asset.public_url === 'string' ? asset.public_url : '';
    if (url === '') continue;
    claimCountByUrl.set(url, (claimCountByUrl.get(url) ?? 0) + 1);
  }

  for (const asset of row.media_assets) {
    if (asset.asset_type !== 'snapshot_image') continue;
    if (asset.is_public_approved !== true) continue;

    const url =
      typeof asset.public_url === 'string'
        ? asset.public_url
        : '';

    const altText =
      typeof asset.alt_text_public === 'string'
        ? asset.alt_text_public.trim()
        : '';

    const galleryPosition = asset.gallery_position;

    if (
      url === '' ||
      claimCountByUrl.get(url) !== 1 ||
      altText === '' ||
      typeof galleryPosition !== 'number' ||
      !Number.isInteger(galleryPosition) ||
      galleryPosition < 1 ||
      galleryPosition > 10
    ) {
      continue;
    }

    mediaByUrl.set(url, {
      altText,
      galleryPosition,
    });
  }

  return snapshots
    .filter((url) => mediaByUrl.has(url))
    .map((url) => {
      const media = mediaByUrl.get(url)!;

      return {
        url,
        altText: media.altText,
        galleryPosition: media.galleryPosition,
      };
    });
}

export class SupabaseProjectRepositoryCore implements ProjectRepository {
  constructor(protected readonly supabase: SupabaseClient) {}

  /** Shared read-only mapper for bounded server-side workflow queries. */
  public mapDbToDomain(row: DatabaseProjectRow): Project {
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
      participantContactEmail: row.participant_contact_email || '',
      teamMembers: row.team_members || [],
      poster: row.poster_url || '',
      posterPdf: row.poster_pdf_url || '',
      posterText: row.poster_text_public || '',
      accessibilityText: row.accessibility_text_public || '',
      snapshots: row.snapshots || [],
      snapshotMedia: mapSnapshotMedia(row),
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
      .select(PROJECT_WITH_RELATIONS_SELECT)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list projects from Supabase: ${error.message}`);
    }

    return (data || []).map((row: DatabaseProjectRow) => this.mapDbToDomain(row));
  }

  private buildFilteredQuery(query: ProjectListQuery, selectOpts?: { count?: 'exact' }) {
    let dbQuery = this.supabase
      .from('projects')
      .select(PROJECT_WITH_RELATIONS_SELECT, selectOpts)
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

    // Apply sort with deterministic public_id tie-breaker
    const allowedSortFieldsMap: Record<string, string> = {
      created_at: 'created_at',
      updated_at: 'updated_at',
      title: 'title',
      year: 'year',
      status: 'status',
    };
    const sortColumn = allowedSortFieldsMap[query.sort || 'created_at'] || 'created_at';
    const isAscending = query.direction === 'asc';

    return dbQuery
      .order(sortColumn, { ascending: isAscending })
      .order('public_id', { ascending: true });
  }

  async listProjectsPage(query: ProjectListQuery): Promise<ProjectListResult> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && [10, 25, 50].includes(query.pageSize) ? query.pageSize : 10;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const dbQuery = this.buildFilteredQuery(query, { count: 'exact' }).range(from, to);

    const { data, count, error } = await dbQuery;

    if (error) {
      throw new Error(`Failed to query paginated projects from Supabase: ${error.message}`);
    }

    const total = count ?? 0;
    const pageCount = total > 0 ? Math.ceil(total / pageSize) : 0;

    // Handle out-of-range page clamping when total > 0 and page > pageCount
    if (total > 0 && page > pageCount) {
      const clampedPage = pageCount;
      const clampedFrom = (clampedPage - 1) * pageSize;
      const clampedTo = clampedFrom + pageSize - 1;

      // Re-run range query for the clamped last page
      const reQuery = this.buildFilteredQuery(query).range(clampedFrom, clampedTo);

      const { data: clampedData, error: clampedError } = await reQuery;
      if (clampedError) {
        throw new Error(`Failed to query clamped page from Supabase: ${clampedError.message}`);
      }

      const clampedProjects = (clampedData || []).map((row: DatabaseProjectRow) => this.mapDbToDomain(row));
      return {
        projects: clampedProjects,
        total,
        page: clampedPage,
        pageSize,
        pageCount,
      };
    }

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
    // Run all four count-only queries concurrently — no row data crosses the wire.
    const [totalRes, publicRes, reviewRes, archiveRes] = await Promise.all([
      this.supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null),
      this.supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .in('status', ['approved', 'published']),
      this.supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .eq('status', 'in_review'),
      this.supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .eq('status', 'archived'),
    ]);

    if (totalRes.error) {
      throw new Error('Failed to fetch project dashboard metrics: unable to retrieve total count');
    }
    if (publicRes.error) {
      throw new Error('Failed to fetch project dashboard metrics: unable to retrieve public-eligible count');
    }
    if (reviewRes.error) {
      throw new Error('Failed to fetch project dashboard metrics: unable to retrieve in-review count');
    }
    if (archiveRes.error) {
      throw new Error('Failed to fetch project dashboard metrics: unable to retrieve archived count');
    }

    return {
      totalProjects: totalRes.count ?? 0,
      publicEligible: publicRes.count ?? 0,
      inReview: reviewRes.count ?? 0,
      archived: archiveRes.count ?? 0,
    };
  }

  async getProjectFilterOptions(): Promise<ProjectFilterOptions> {
    const yearsSet = new Set<string>();
    const programsSet = new Set<string>();
    const disciplinesSet = new Set<string>();

    let iteration = 0;
    let offset = 0;

    while (iteration < PROJECT_FILTER_OPTION_MAX_ITERATIONS) {
      iteration++;
      const from = offset;
      const to = offset + PROJECT_FILTER_OPTION_CHUNK_SIZE - 1;

      const { data, error } = await this.supabase
        .from('projects')
        .select('year, program_name, discipline')
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to);

      if (error) {
        throw new Error('Failed to fetch project filter options');
      }

      const rows = data || [];

      for (const row of rows) {
        if (row.year) yearsSet.add(row.year.toString());
        if (row.program_name && row.program_name.trim()) programsSet.add(row.program_name.trim());
        if (row.discipline && row.discipline.trim()) disciplinesSet.add(row.discipline.trim());
      }

      if (rows.length < PROJECT_FILTER_OPTION_CHUNK_SIZE) {
        break;
      }

      offset += PROJECT_FILTER_OPTION_CHUNK_SIZE;
    }

    if (iteration >= PROJECT_FILTER_OPTION_MAX_ITERATIONS) {
      throw new Error('Failed to fetch project filter options: exceeded maximum iteration limit');
    }

    const years = Array.from(yearsSet).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    const programs = Array.from(programsSet).sort((a, b) => a.localeCompare(b));
    const disciplines = Array.from(disciplinesSet).sort((a, b) => a.localeCompare(b));

    return {
      years,
      programs,
      disciplines,
    };
  }

  async getProjectByPublicId(publicId: string): Promise<Project | null> {
    const { data, error } = await this.supabase
      .from('projects')
      .select(PROJECT_WITH_RELATIONS_SELECT)
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
      .select(PROJECT_WITH_RELATIONS_SELECT)
      .single();

    if (error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }

    return this.mapDbToDomain(data as DatabaseProjectRow);
  }

  async performReviewAction(params: {
    publicId: string;
    action: 'request_changes' | 'approve' | 'archive';
    comments?: string;
    adminId: string;
  }): Promise<{ publicId: string; status: Project['status']; auditRecordId: string }> {
    const { publicId, action, comments, adminId } = params;

    if (!adminId || typeof adminId !== 'string' || !publicId || typeof publicId !== 'string' || !action) {
      throw new ReviewActionExecutionError('INPUT_INVALID');
    }

    const { data, error } = await this.supabase.rpc('perform_project_review_action', {
      p_public_id: publicId,
      p_action: action,
      p_comments: comments || null,
      p_admin_id: adminId,
    });

    if (error) {
      const rawMsg = error.message || '';
      let code: ReviewActionExecutionErrorCode = 'INTERNAL_FAILURE';

      if (rawMsg.includes('PUBLICATION_IN_PROGRESS')) {
        code = 'PUBLICATION_IN_PROGRESS';
      } else if (rawMsg.includes('CONTROLLED_PUBLIC_REMOVAL_REQUIRED')) {
        code = 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED';
      } else if (rawMsg.includes('REVIEW_PROJECT_NOT_FOUND')) {
        code = 'PROJECT_NOT_FOUND';
      } else if (rawMsg.includes('REVIEW_TRANSITION_INVALID')) {
        code = 'TRANSITION_INVALID';
      } else if (rawMsg.includes('REVIEW_PERMISSION_DENIED')) {
        code = 'PERMISSION_DENIED';
      } else if (
        rawMsg.includes('REVIEW_PUBLIC_ID_REQUIRED') ||
        rawMsg.includes('REVIEW_PUBLIC_ID_INVALID') ||
        rawMsg.includes('REVIEW_ACTION_INVALID') ||
        rawMsg.includes('REVIEW_COMMENTS_TOO_LONG') ||
        rawMsg.includes('REVIEW_ADMIN_ID_REQUIRED')
      ) {
        code = 'INPUT_INVALID';
      }

      throw new ReviewActionExecutionError(code);
    }

    if (!data || typeof data !== 'object') {
      throw new ReviewActionExecutionError('RESPONSE_INVALID');
    }

    const res = data as Record<string, unknown>;
    if (
      res.resultCode === 'CORRECTION_RESOLUTION_REQUIRED' ||
      res.resultCode === 'AMBIGUOUS_ACTIVE_PREVIEW' ||
      res.resultCode === 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED' ||
      res.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED' ||
      res.resultCode === 'ACCESSIBILITY_CONTENT_INVALID' ||
      res.resultCode === 'PROJECT_MEDIA_REQUIRED' ||
      res.resultCode === 'PROJECT_MEDIA_INVALID' ||
      res.resultCode === 'MEDIA_ACCESSIBILITY_REQUIRED' ||
      res.resultCode === 'MEDIA_ACCESSIBILITY_INVALID'
    ) {
      throw new ReviewActionExecutionError(res.resultCode);
    }
    const resPublicId = res.publicId;
    const resStatus = res.status;
    const resAuditRecordId = res.auditRecordId;

    const validStatuses: Array<Project['status']> = [
      'draft',
      'submitted',
      'in_review',
      'changes_requested',
      'approved',
      'published',
      'archived',
      'deleted',
    ];

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      typeof resPublicId !== 'string' ||
      !resPublicId ||
      typeof resStatus !== 'string' ||
      !validStatuses.includes(resStatus as Project['status']) ||
      typeof resAuditRecordId !== 'string' ||
      !uuidRegex.test(resAuditRecordId)
    ) {
      throw new ReviewActionExecutionError('RESPONSE_INVALID');
    }

    return {
      publicId: resPublicId,
      status: resStatus as Project['status'],
      auditRecordId: resAuditRecordId,
    };
  }
}
