import { WorkflowStatus } from './workflowStatus';
import { Project } from './project';

export type AllowedSortField = 'created_at' | 'updated_at' | 'title' | 'year' | 'status';
export type SortDirection = 'asc' | 'desc';
export type PageSizeOption = 10 | 25 | 50;

export interface ProjectListQuery {
  search?: string;
  status?: WorkflowStatus;
  year?: string;
  program?: string;
  discipline?: string;
  sort?: AllowedSortField;
  direction?: SortDirection;
  page?: number;
  pageSize?: PageSizeOption;
}

export interface ProjectListResult {
  projects: Project[];
  total: number;
  page: number;
  pageSize: PageSizeOption;
  pageCount: number;
}

export interface ProjectDashboardMetrics {
  totalProjects: number;
  publicEligible: number;
  inReview: number;
  archived: number;
}

export interface ProjectFilterOptions {
  years: string[];
  programs: string[];
  disciplines: string[];
}

/**
 * Normalizes and escapes user search input using a conservative allowlist (Unicode letters/numbers, spaces, hyphens).
 */
export function normalizeSearchInput(rawSearch: unknown): string {
  if (typeof rawSearch !== 'string') return '';

  let cleaned = rawSearch.trim().slice(0, 100);

  // Remove control characters
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');

  // Conservative allowlist: keep Unicode letters/numbers (\p{L}, \p{N}), spaces, and hyphens. Replace everything else with space.
  cleaned = cleaned.replace(/[^\p{L}\p{N}\s-]/gu, ' ');

  // Collapse multiple spaces
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * Parses and sanitizes raw URL search parameters into a safe, strongly-typed ProjectListQuery.
 */
export function parseProjectListQuery(rawParams: Record<string, string | string[] | undefined>): ProjectListQuery {
  const getSingleString = (key: string): string | undefined => {
    const val = rawParams[key];
    if (Array.isArray(val)) return val[0];
    return typeof val === 'string' ? val : undefined;
  };

  const rawSearch = getSingleString('q') || getSingleString('search');
  const search = normalizeSearchInput(rawSearch);

  const rawStatus = getSingleString('status');
  const validStatuses: WorkflowStatus[] = [
    'draft',
    'submitted',
    'in_review',
    'changes_requested',
    'approved',
    'published',
    'archived',
    'deleted',
  ];
  const status = validStatuses.includes(rawStatus as WorkflowStatus)
    ? (rawStatus as WorkflowStatus)
    : undefined;

  const rawYear = getSingleString('year');
  const year = rawYear && /^\d{4}$/.test(rawYear.trim()) ? rawYear.trim() : undefined;

  const rawProgram = getSingleString('program');
  const program = rawProgram && rawProgram.trim() ? rawProgram.trim().slice(0, 100) : undefined;

  const rawDiscipline = getSingleString('discipline');
  const discipline = rawDiscipline && rawDiscipline.trim() ? rawDiscipline.trim().slice(0, 100) : undefined;

  const rawSort = getSingleString('sort');
  const validSortFields: AllowedSortField[] = ['created_at', 'updated_at', 'title', 'year', 'status'];
  const sort: AllowedSortField = validSortFields.includes(rawSort as AllowedSortField)
    ? (rawSort as AllowedSortField)
    : 'created_at';

  const rawDirection = getSingleString('direction');
  const direction: SortDirection = rawDirection === 'asc' ? 'asc' : 'desc';

  // Strict full-string decimal-integer check for page (e.g. "1", "25", no decimals, signs or trailing letters)
  const rawPage = getSingleString('page');
  const page = rawPage && /^[1-9]\d*$/.test(rawPage.trim()) ? parseInt(rawPage.trim(), 10) : 1;

  // Strict full-string decimal-integer check for pageSize
  const rawPageSize = getSingleString('pageSize');
  const parsedPageSize = rawPageSize && /^\d+$/.test(rawPageSize.trim()) ? parseInt(rawPageSize.trim(), 10) : 10;
  const allowedSizes: PageSizeOption[] = [10, 25, 50];
  const pageSize: PageSizeOption = allowedSizes.includes(parsedPageSize as PageSizeOption)
    ? (parsedPageSize as PageSizeOption)
    : 10;

  return {
    search: search || undefined,
    status,
    year,
    program,
    discipline,
    sort,
    direction,
    page,
    pageSize,
  };
}
