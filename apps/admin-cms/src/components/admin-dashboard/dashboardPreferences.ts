import type {
  AllowedSortField,
  PageSizeOption,
  SortDirection,
} from '../../domain/projectQuery';
import type { WorkflowStatus } from '../../domain/workflowStatus';

export const DASHBOARD_PREFERENCES_KEY =
  'capstone-impact-platform:admin-dashboard-preferences:v1';

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  pageSize: 10,
  sort: 'created_at',
  direction: 'desc',
  visibleColumns: [
    'title',
    'status',
    'program',
    'year',
    'validation',
    'updatedAt',
    'actions',
  ],
  status: '',
  program: '',
  discipline: '',
  year: '',
};

export interface DashboardPreferences {
  pageSize: PageSizeOption;
  sort: AllowedSortField;
  direction: SortDirection;
  visibleColumns: string[];
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

const ALLOWED_COLUMNS = new Set([
  'title',
  'status',
  'program',
  'year',
  'validation',
  'updatedAt',
  'actions',
]);

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

function sanitizeColumns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_DASHBOARD_PREFERENCES.visibleColumns;
  }

  const columns = value.filter(
    (column): column is string =>
      typeof column === 'string' && ALLOWED_COLUMNS.has(column),
  );

  // Do not allow corrupted data to hide every column.
  if (columns.length === 0) {
    return DEFAULT_DASHBOARD_PREFERENCES.visibleColumns;
  }

  return [...new Set(columns)];
}

export function validateDashboardPreferences(
  value: unknown,
): DashboardPreferences {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DASHBOARD_PREFERENCES };
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

// export function loadDashboardPreferences(): DashboardPreferences {
//   if (typeof window === 'undefined') {
//     return { ...DEFAULT_DASHBOARD_PREFERENCES };
//   }

//   try {
//     const raw = window.localStorage.getItem(DASHBOARD_PREFERENCES_KEY);

//     if (!raw) {
//       return { ...DEFAULT_DASHBOARD_PREFERENCES };
//     }

//     const parsed: unknown = JSON.parse(raw);

//     return validateDashboardPreferences(parsed);
//   } catch {
//     return { ...DEFAULT_DASHBOARD_PREFERENCES };
//   }
// }

export function loadDashboardPreferences(): DashboardPreferences {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_DASHBOARD_PREFERENCES };
  }


  try {
    const raw = window.localStorage.getItem(DASHBOARD_PREFERENCES_KEY);

    if (!raw) {
      return { ...DEFAULT_DASHBOARD_PREFERENCES };
    }

    const parsed: unknown = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      !('preferences' in parsed)
    ) {
      return { ...DEFAULT_DASHBOARD_PREFERENCES };
    }

    const stored = parsed as {
      version?: unknown;
      preferences?: unknown;
    };

    // Reject unsupported storage versions.
    if (stored.version !== 1) {
      return { ...DEFAULT_DASHBOARD_PREFERENCES };
    }

    return validateDashboardPreferences(stored.preferences);
  } catch {
    // Corrupted JSON or unavailable localStorage.
    return { ...DEFAULT_DASHBOARD_PREFERENCES };
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

  return { ...DEFAULT_DASHBOARD_PREFERENCES };
}