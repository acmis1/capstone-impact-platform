import { Project } from '../domain/project';

export interface ProjectRepository {
  /**
   * Retrieves all projects in the database that are not soft-deleted.
   */
  listProjects(): Promise<Project[]>;

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
   * Updates an existing project's fields.
   * @param id The internal database UUID or public ID to update.
   * @param patch Partial project updates
   */
  updateProject(id: string, patch: Partial<Project>): Promise<Project>;

  /**
   * Archives a project, marking it as archived with an audited reason.
   * @param id The internal database UUID or public ID
   * @param reason The auditing explanation for archiving the project
   */
  archiveProject(id: string, reason: string): Promise<Project>;

  /**
   * Performs a soft delete by setting the deleted_at timestamp.
   * @param id The internal database UUID or public ID
   */
  softDeleteProject(id: string): Promise<void>;

  /**
   * Safe staging review action transition mapping project workflows and audit tracking.
   */
  performReviewAction(params: {
    publicId: string;
    action: 'request_changes' | 'approve' | 'archive';
    comments?: string;
    adminId?: string | null;
  }): Promise<Project>;
}
