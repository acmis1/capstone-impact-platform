import { Project } from '../domain/project';
import {
  ProjectListQuery,
  ProjectListResult,
  ProjectDashboardMetrics,
  ProjectFilterOptions,
} from '../domain/projectQuery';

export type ReviewActionExecutionErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'TRANSITION_INVALID'
  | 'PERMISSION_DENIED'
  | 'CORRECTION_RESOLUTION_REQUIRED'
  | 'AMBIGUOUS_ACTIVE_PREVIEW'
  | 'PUBLICATION_IN_PROGRESS'
  | 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED'
  | 'ACCESSIBILITY_CONTENT_REQUIRED'
  | 'ACCESSIBILITY_CONTENT_INVALID'
  /** Required poster image/PDF rows are absent from authoritative project media. */
  | 'PROJECT_MEDIA_REQUIRED'
  /** Project media rows exist but are ambiguous, malformed, public, or outside private staging. */
  | 'PROJECT_MEDIA_INVALID'
  /** The project's snapshot image has no usable text alternative; approval is blocked. */
  | 'MEDIA_ACCESSIBILITY_REQUIRED'
  /** The snapshot image's text alternative exceeds its bounded ceiling; approval is blocked. */
  | 'MEDIA_ACCESSIBILITY_INVALID'
  | 'INPUT_INVALID'
  | 'RESPONSE_INVALID'
  | 'INTERNAL_FAILURE';

export class ReviewActionExecutionError extends Error {
  readonly code: ReviewActionExecutionErrorCode;

  constructor(code: ReviewActionExecutionErrorCode) {
    super(`Review action execution failed: ${code}`);
    this.name = 'ReviewActionExecutionError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ReviewActionExecutionResult {
  publicId: string;
  status: Project['status'];
  auditRecordId: string;
}

export interface ProjectRepository {
  /**
   * Retrieves all projects in the database that are not soft-deleted.
   */
  listProjects(): Promise<Project[]>;

  /**
   * Retrieves a paginated, filtered, and sorted list of projects with total exact count.
   */
  listProjectsPage(query: ProjectListQuery): Promise<ProjectListResult>;

  /**
   * Retrieves high-level operational metrics across the full non-deleted project collection.
   */
  getProjectDashboardMetrics(): Promise<ProjectDashboardMetrics>;

  /**
   * Retrieves lightweight, distinct filter options (years, programs, disciplines) across non-deleted records.
   */
  getProjectFilterOptions(): Promise<ProjectFilterOptions>;

  /**
   * Retrieves a single project by its deterministic public identifier.
   * @param publicId Unique deterministic public identifier (e.g. "2026-slug")
   */
  getProjectByPublicId(publicId: string): Promise<Project | null>;

  /**
   * Creates a new project in the repository.
   * @param input Project data input
   */
  createProject(input: Partial<Project> & { title: string; year: string; publicId: string }): Promise<Project>;

  /**
   * Safe atomic review action transition mapping project workflows and audit tracking via PostgreSQL RPC.
   */
  performReviewAction(params: {
    publicId: string;
    action: 'request_changes' | 'approve' | 'archive';
    comments?: string;
    adminId: string;
  }): Promise<ReviewActionExecutionResult>;
}
