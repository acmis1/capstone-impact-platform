import type {
  AllowedSortField,
  PageSizeOption,
  SortDirection,
} from '../../domain/projectQuery';
import type { WorkflowStatus } from '../../domain/workflowStatus';

export const DASHBOARD_PREFERENCES_KEY =
  'capstone-impact-platform:admin-dashboard-preferences:v1';

export const DASHBOARD_COLUMN_IDS = [
  'title',
  'status',
  'program',
  'year',
  'validation',
  'updatedAt',
  'actions',
] as const;

export type DashboardColumnId = (typeof DASHBOARD_COLUMN_IDS)[number];

export const DASHBOARD_CONFIGURABLE_COLUMN_IDS = [
  'status',
  'program',
  'year',
  'validation',
  'updatedAt',
] as const satisfies readonly DashboardColumnId[];

const DASHBOARD_MANDATORY_COLUMN_IDS = ['title', 'actions'] as const;

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  pageSize: 10,
  sort: 'created_at',
  direction: 'desc',
  visibleColumns: [...DASHBOARD_COLUMN_IDS],
  status: '',
  program: '',
  discipline: '',
  year: '',
};

export interface DashboardPreferences {
  pageSize: PageSizeOption;
  sort: AllowedSortField;
  direction: SortDirection;
  visibleColumns: DashboardColumnId[];
  status: WorkflowStatus | '';
  program: string;
  discipline: string;
  year: string;
}

const ALLOWED_PAGE_SIZES: PageSizeOption[] = [10, 25, 50];

const ALLOWED_SORT_FIELDS: AllowedSortField[] = [
  'created_at',
  'updated_at',
  'title',
  'year',
  'status',
];

const ALLOWED_DIRECTIONS: SortDirection[] = ['asc', 'desc'];

const ALLOWED_STATUSES: WorkflowStatus[] = [
  'draft',
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'archived',
  'deleted',
];

const ALLOWED_COLUMNS = new Set<string>(DASHBOARD_COLUMN_IDS);

function defaultDashboardPreferences(): DashboardPreferences {
  return {
    ...DEFAULT_DASHBOARD_PREFERENCES,
    visibleColumns: [...DEFAULT_DASHBOARD_PREFERENCES.visibleColumns],
  };
}

function isPageSize(value: unknown): value is PageSizeOption {
  return (
    typeof value === 'number' &&
    ALLOWED_PAGE_SIZES.includes(value as PageSizeOption)
  );
}

function isSortField(value: unknown): value is AllowedSortField {
  return (
    typeof value === 'string' &&
    ALLOWED_SORT_FIELDS.includes(value as AllowedSortField)
  );
}

function isSortDirection(value: unknown): value is SortDirection {
  return (
    typeof value === 'string' &&
    ALLOWED_DIRECTIONS.includes(value as SortDirection)
  );
}

function isStatus(value: unknown): value is WorkflowStatus | '' {
  return (
    value === '' ||
    (typeof value === 'string' &&
      ALLOWED_STATUSES.includes(value as WorkflowStatus))
  );
}

function sanitizeColumns(value: unknown): DashboardColumnId[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_DASHBOARD_PREFERENCES.visibleColumns];
  }

  const requestedColumns = new Set(
    value.filter(
      (column): column is DashboardColumnId =>
        typeof column === 'string' && ALLOWED_COLUMNS.has(column),
    ),
  );

  // An empty or unknown-only value is corrupt. A title/actions-only value is
  // valid: users may hide every configurable desktop column.
  if (requestedColumns.size === 0) {
    return [...DEFAULT_DASHBOARD_PREFERENCES.visibleColumns];
  }

  return DASHBOARD_COLUMN_IDS.filter(
    (column) =>
      DASHBOARD_MANDATORY_COLUMN_IDS.includes(
        column as (typeof DASHBOARD_MANDATORY_COLUMN_IDS)[number],
      ) || requestedColumns.has(column),
  );
}

export function validateDashboardPreferences(
  value: unknown,
): DashboardPreferences {
  if (!value || typeof value !== 'object') {
    return defaultDashboardPreferences();
  }

  const raw = value as Record<string, unknown>;

  return {
    pageSize: isPageSize(raw.pageSize)
      ? raw.pageSize
      : DEFAULT_DASHBOARD_PREFERENCES.pageSize,

    sort: isSortField(raw.sort)
      ? raw.sort
      : DEFAULT_DASHBOARD_PREFERENCES.sort,

    direction: isSortDirection(raw.direction)
      ? raw.direction
      : DEFAULT_DASHBOARD_PREFERENCES.direction,

    visibleColumns: sanitizeColumns(raw.visibleColumns),

    status: isStatus(raw.status)
      ? raw.status
      : DEFAULT_DASHBOARD_PREFERENCES.status,

    program:
      typeof raw.program === 'string'
        ? raw.program.slice(0, 100)
        : DEFAULT_DASHBOARD_PREFERENCES.program,

    discipline:
      typeof raw.discipline === 'string'
        ? raw.discipline.slice(0, 100)
        : DEFAULT_DASHBOARD_PREFERENCES.discipline,

    year:
      typeof raw.year === 'string' && /^\d{4}$/.test(raw.year)
        ? raw.year
        : DEFAULT_DASHBOARD_PREFERENCES.year,
  };
}

export function loadDashboardPreferences(): DashboardPreferences {
  if (typeof window === 'undefined') {
    return defaultDashboardPreferences();
  }

  try {
    const raw = window.localStorage.getItem(DASHBOARD_PREFERENCES_KEY);

    if (!raw) {
      return defaultDashboardPreferences();
    }

    const parsed: unknown = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      !('preferences' in parsed)
    ) {
      return defaultDashboardPreferences();
    }

    const stored = parsed as {
      version?: unknown;
      preferences?: unknown;
    };

    // Reject unsupported storage versions.
    if (stored.version !== 1) {
      return defaultDashboardPreferences();
    }

    return validateDashboardPreferences(stored.preferences);
  } catch {
    // Corrupted JSON or unavailable localStorage.
    return defaultDashboardPreferences();
  }
}


export function saveDashboardPreferences(
  preferences: DashboardPreferences,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const validated = validateDashboardPreferences(preferences);

    window.localStorage.setItem(
      DASHBOARD_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        preferences: validated,
      }),
    );
  } catch {
    // Storage may be disabled, full, or unavailable.
    // Dashboard must continue working normally.
  }
}

export function resetDashboardPreferences(): DashboardPreferences {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(DASHBOARD_PREFERENCES_KEY);
    } catch {
      // Ignore unavailable storage.
    }
  }

  return defaultDashboardPreferences();
}
