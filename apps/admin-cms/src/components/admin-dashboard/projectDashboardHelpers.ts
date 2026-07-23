import { Project } from '../../domain/project';
import { WorkflowStatus } from '../../domain/workflowStatus';

/**
 * Returns a valid URI-encoded project detail URL for non-empty public IDs, or null if missing/blank.
 */
export function getProjectDetailHref(publicId?: string | null): string | null {
  if (!publicId || !publicId.trim()) {
    return null;
  }
  return `/admin/projects/${encodeURIComponent(publicId.trim())}`;
}

export interface ValidationStatusOutcome {
  label: string;
  variant: 'destructive' | 'warning' | 'success';
}

/**
 * Interprets validation error and warning counts/flags into strongly-typed status outcome.
 * Blocking errors take precedence over warnings.
 */
export function getValidationOutcome(project: Partial<Project>): ValidationStatusOutcome {
  const flags = project.validationFlags;
  const errorsCount = project.validationErrors?.length || 0;
  const warningsCount = project.validationWarnings?.length || 0;

  if (errorsCount > 0 || flags?.hasErrors) {
    return {
      label: errorsCount > 0 ? `${errorsCount} Error${errorsCount > 1 ? 's' : ''}` : 'Needs attention',
      variant: 'destructive',
    };
  }

  if (warningsCount > 0 || flags?.hasWarnings) {
    return {
      label: warningsCount > 0 ? `${warningsCount} Warning${warningsCount > 1 ? 's' : ''}` : 'Warnings',
      variant: 'warning',
    };
  }

  return {
    label: 'Ready',
    variant: 'success',
  };
}

/**
 * Maps a table column ID to its corresponding database sort field name.
 * Returns null for non-sortable columns or unknown IDs.
 *
 * - title     → "title"
 * - status    → "status"
 * - year      → "year"
 * - updatedAt → "updated_at"
 * - all other column IDs → null
 */
export function getProjectColumnSortField(columnId: string): string | null {
  const sortFieldMap: Record<string, string> = {
    title: 'title',
    status: 'status',
    year: 'year',
    updatedAt: 'updated_at',
  };
  return sortFieldMap[columnId] ?? null;
}

export interface ProjectIndexRow {
  id: string;
  publicId?: string;
  title: string;
  status: WorkflowStatus;
  program?: string;
  discipline?: string;
  year?: string;
  groupName?: string;
  industryPartner?: string;
  createdAt?: string;
  updatedAt?: string;
  validationLabel: string;
  validationVariant: 'destructive' | 'warning' | 'success';
}

export interface ProjectIndexResult {
  rows: ProjectIndexRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Maps a complete internal Project domain entity into a client-safe ProjectIndexRow DTO.
 * Excludes internal notes, private comments, raw validation arrays, media URLs, and unused CMS metadata.
 */
export function toProjectIndexRow(project: Project): ProjectIndexRow {
  const validation = getValidationOutcome(project);
  return {
    id: String(project.id),
    publicId: project.publicId,
    title: project.title,
    status: project.status,
    program: project.program,
    discipline: project.discipline,
    year: project.year,
    groupName: project.groupName,
    industryPartner: project.industryPartner,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    validationLabel: validation.label,
    validationVariant: validation.variant,
  };
}
