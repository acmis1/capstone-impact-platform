'use client';

import * as React from 'react';
import type {
  AllowedSortField,
  PageSizeOption,
  SortDirection,
} from '../../domain/projectQuery';

const STORAGE_KEY = 'capstone-impact:dashboard-preferences:v1';

const DEFAULT_PREFERENCES: DashboardPreferences = {
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

const ALLOWED_PAGE_SIZES: PageSizeOption[] = [10, 25, 50];

const ALLOWED_SORT_FIELDS: AllowedSortField[] = [
  'created_at',
  'updated_at',
  'title',
  'year',
  'status',
];

const ALLOWED_SORT_DIRECTIONS: SortDirection[] = ['asc', 'desc'];

const ALLOWED_COLUMNS = [
  'title',
  'status',
  'program',
  'year',
  'validation',
  'updatedAt',
  'actions',
] as const;

export type DashboardColumnId = (typeof ALLOWED_COLUMNS)[number];

export interface DashboardPreferences {
  pageSize: PageSizeOption;
  sort: AllowedSortField;
  direction: SortDirection;
  visibleColumns: DashboardColumnId[];
  status: string;
  program: string;
  discipline: string;
  year: string;
}

function isValidPageSize(value: unknown): value is PageSizeOption {
  return (
    typeof value === 'number' &&
    ALLOWED_PAGE_SIZES.includes(value as PageSizeOption)
  );
}

function isValidSortField(value: unknown): value is AllowedSortField {
  return (
    typeof value === 'string' &&
    ALLOWED_SORT_FIELDS.includes(value as AllowedSortField)
  );
}

function isValidSortDirection(value: unknown): value is SortDirection {
  return (
    typeof value === 'string' &&
    ALLOWED_SORT_DIRECTIONS.includes(value as SortDirection)
  );
}

function isValidColumn(value: unknown): value is DashboardColumnId {
  return (
    typeof value === 'string' &&
    ALLOWED_COLUMNS.includes(value as DashboardColumnId)
  );
}

function validatePreferences(
  value: unknown,
): DashboardPreferences {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_PREFERENCES };
  }

  const raw = value as Partial<DashboardPreferences>;

  const pageSize = isValidPageSize(raw.pageSize)
    ? raw.pageSize
    : DEFAULT_PREFERENCES.pageSize;

  const sort = isValidSortField(raw.sort)
    ? raw.sort
    : DEFAULT_PREFERENCES.sort;

  const direction = isValidSortDirection(raw.direction)
    ? raw.direction
    : DEFAULT_PREFERENCES.direction;

  const visibleColumns = Array.isArray(raw.visibleColumns)
    ? raw.visibleColumns.filter(isValidColumn)
    : DEFAULT_PREFERENCES.visibleColumns;

  return {
    pageSize,
    sort,
    direction,
    visibleColumns:
      visibleColumns.length > 0
        ? [...new Set(visibleColumns)]
        : [...DEFAULT_PREFERENCES.visibleColumns],
    status:
      typeof raw.status === 'string'
        ? raw.status
        : DEFAULT_PREFERENCES.status,
    program:
      typeof raw.program === 'string'
        ? raw.program
        : DEFAULT_PREFERENCES.program,
    discipline:
      typeof raw.discipline === 'string'
        ? raw.discipline
        : DEFAULT_PREFERENCES.discipline,
    year:
      typeof raw.year === 'string'
        ? raw.year
        : DEFAULT_PREFERENCES.year,
  };
}

function loadPreferences(): DashboardPreferences {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_PREFERENCES };
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);

    if (!stored) {
      return { ...DEFAULT_PREFERENCES };
    }

    const parsed: unknown = JSON.parse(stored);

    return validatePreferences(parsed);
  } catch {
    // localStorage unavailable or stored data corrupted.
    return { ...DEFAULT_PREFERENCES };
  }
}

function savePreferences(
  preferences: DashboardPreferences,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Browser storage may be unavailable.
    // Preferences continue working in memory.
  }
}

export function useDashboardPreferences() {
  const [preferences, setPreferences] =
    React.useState<DashboardPreferences>(() => ({
      ...DEFAULT_PREFERENCES,
    }));

  const [isLoaded, setIsLoaded] = React.useState(false);

  React.useEffect(() => {
    const storedPreferences = loadPreferences();

    // Hydrate client-only preferences after mount.
    // localStorage is unavailable during SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferences(storedPreferences);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoaded(true);
  }, []);

  React.useEffect(() => {
    if (!isLoaded) {
      return;
    }

    savePreferences(preferences);
  }, [preferences, isLoaded]);

  const updatePreferences = React.useCallback(
    (updates: Partial<DashboardPreferences>) => {
      setPreferences((current) => ({
        ...current,
        ...updates,
      }));
    },
    [],
  );

  const resetPreferences = React.useCallback(() => {
    const defaults = {
      ...DEFAULT_PREFERENCES,
      visibleColumns: [
        ...DEFAULT_PREFERENCES.visibleColumns,
      ],
    };

    setPreferences(defaults);

    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore unavailable localStorage.
      }
    }
  }, []);

  return {
    preferences,
    updatePreferences,
    resetPreferences,
    isLoaded,
  };
}

export { STORAGE_KEY, DEFAULT_PREFERENCES };