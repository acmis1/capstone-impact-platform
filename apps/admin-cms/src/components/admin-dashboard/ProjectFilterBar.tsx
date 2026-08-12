'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';

import type { PageSizeOption, ProjectListQuery } from '../../domain/projectQuery';
import type { WorkflowStatus } from '../../domain/workflowStatus';
import { Button } from '../ui/button';
import { buildQueryString } from './filterQueryHelpers';
import { useDashboardPreferences } from './useDashboardPreferences';

const STATUSES: readonly WorkflowStatus[] = [
  'draft',
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'archived',
  'deleted',
];

const PREFERENCE_QUERY_KEYS = [
  'status',
  'year',
  'program',
  'discipline',
  'pageSize',
  'sort',
  'direction',
] as const;

type PreferenceQueryKey = (typeof PREFERENCE_QUERY_KEYS)[number];

export interface ProjectFilterBarProps {
  query: ProjectListQuery;
  availableYears: string[];
  availablePrograms: string[];
  availableDisciplines: string[];
}

function navigationHref(pathname: string, params: URLSearchParams): string {
  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

function isPageSize(value: string | null): value is `${PageSizeOption}` {
  return value !== null && ['10', '25', '50'].includes(value.trim());
}

function hasValidExplicitValue(
  key: PreferenceQueryKey,
  value: string | null,
): boolean {
  switch (key) {
    case 'status':
      return value !== null && STATUSES.includes(value as WorkflowStatus);
    case 'year':
      return value !== null && /^\d{4}$/.test(value.trim());
    case 'program':
    case 'discipline':
      return value !== null && Boolean(value.trim());
    case 'pageSize':
      return isPageSize(value);
    case 'sort':
      return value !== null && ['created_at', 'updated_at', 'title', 'year', 'status'].includes(value);
    case 'direction':
      return value === 'asc' || value === 'desc';
  }
}

export function ProjectFilterBar({
  query,
  availableYears,
  availablePrograms,
  availableDisciplines,
}: ProjectFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { preferences, updatePreferences, resetPreferences, isLoaded } =
    useDashboardPreferences();
  const rawSearchParams = searchParams?.toString() || '';

  const [searchInput, setSearchInput] = React.useState(query.search || '');
  const [previousQuerySearch, setPreviousQuerySearch] = React.useState(query.search);

  if (query.search !== previousQuerySearch) {
    setPreviousQuerySearch(query.search);
    setSearchInput(query.search || '');
  }

  React.useEffect(() => {
    if (!isLoaded) return;

    const params = new URLSearchParams(rawSearchParams);
    const preferenceRepairs: Partial<typeof preferences> = {};

    const storedFilterIsAvailable = (
      key: 'year' | 'program' | 'discipline',
      value: string,
    ) => {
      if (!value) return true;
      const options = key === 'year'
        ? availableYears
        : key === 'program'
          ? availablePrograms
          : availableDisciplines;
      return options.includes(value);
    };

    const applyStoredOrExplicit = (
      key: PreferenceQueryKey,
      storedValue: string | number,
      defaultValue: string | number,
    ) => {
      if (params.has(key)) {
        const explicitValue = params.get(key);
        if (!hasValidExplicitValue(key, explicitValue)) {
          // Canonicalize malformed explicit values to a safe explicit value.
          // This ensures an old stored value never takes authority on the next render.
          params.set(key, key === 'status' || key === 'year' || key === 'program' || key === 'discipline'
            ? ''
            : String(defaultValue));
        }
        return;
      }

      if (
        (key === 'year' || key === 'program' || key === 'discipline') &&
        !storedFilterIsAvailable(key, String(storedValue))
      ) {
        preferenceRepairs[key] = '';
        return;
      }

      if (storedValue !== defaultValue && storedValue !== '') {
        params.set(key, String(storedValue));
      }
    };

    // Raw URL presence is intentionally consulted before parsed query values:
    // parseProjectListQuery supplies defaults for absent parameters.
    applyStoredOrExplicit('status', preferences.status, '');
    applyStoredOrExplicit('year', preferences.year, '');
    applyStoredOrExplicit('program', preferences.program, '');
    applyStoredOrExplicit('discipline', preferences.discipline, '');
    applyStoredOrExplicit('pageSize', preferences.pageSize, 10);
    applyStoredOrExplicit('sort', preferences.sort, 'created_at');
    applyStoredOrExplicit('direction', preferences.direction, 'desc');

    if (Object.keys(preferenceRepairs).length > 0) {
      updatePreferences(preferenceRepairs);
    }

    if (params.toString() !== rawSearchParams) {
      router.replace(navigationHref(pathname, params));
    }
  }, [
    availableDisciplines,
    availablePrograms,
    availableYears,
    isLoaded,
    pathname,
    preferences,
    rawSearchParams,
    router,
    updatePreferences,
  ]);

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const queryString = buildQueryString(rawSearchParams, {
      q: searchInput.trim() || null,
      search: null,
    });
    router.push(navigationHref(pathname, new URLSearchParams(queryString)));
  };

  const handleFilterChange = (key: PreferenceQueryKey, value: string) => {
    if (key === 'status') {
      updatePreferences({ status: value as WorkflowStatus | '' });
    } else if (key === 'year') {
      updatePreferences({ year: value });
    } else if (key === 'program') {
      updatePreferences({ program: value });
    } else if (key === 'discipline') {
      updatePreferences({ discipline: value });
    } else if (key === 'pageSize' && isPageSize(value)) {
      updatePreferences({ pageSize: Number(value) as PageSizeOption });
    } else {
      return;
    }

    const queryString = buildQueryString(rawSearchParams, { [key]: value || null });
    router.push(navigationHref(pathname, new URLSearchParams(queryString)));
  };

  const handleClearFilters = () => {
    setSearchInput('');
    updatePreferences({ status: '', year: '', program: '', discipline: '' });
    const queryString = buildQueryString(rawSearchParams, {
      q: null,
      search: null,
      status: null,
      year: null,
      program: null,
      discipline: null,
    });
    router.push(navigationHref(pathname, new URLSearchParams(queryString)));
  };

  const handleResetPreferences = () => {
    resetPreferences();
    const params = new URLSearchParams(rawSearchParams);
    for (const key of PREFERENCE_QUERY_KEYS) params.delete(key);
    params.delete('page');
    // Search remains transient: Reset Preferences intentionally preserves it.
    router.push(navigationHref(pathname, params));
  };

  const hasActiveFilters = Boolean(
    query.search || query.status || query.year || query.program || query.discipline,
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs">
      <form onSubmit={handleSearchSubmit} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by title, public ID, partner, or group..."
            aria-label="Search projects"
            className="min-h-[44px] w-full rounded-md border bg-background py-2 pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="default" className="min-h-[44px]">Search</Button>
          {hasActiveFilters && (
            <Button type="button" variant="outline" onClick={handleClearFilters} className="min-h-[44px] gap-1">
              <X className="h-4 w-4" aria-hidden="true" />
              <span>Clear</span>
            </Button>
          )}
          <Button type="button" variant="outline" onClick={handleResetPreferences}>
            Reset preferences
          </Button>
        </div>
      </form>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <FilterSelect id="filter-status" label="Status" value={query.status || ''} onChange={(value) => handleFilterChange('status', value)}>
          <option value="">All statuses</option>
          {STATUSES.map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
        </FilterSelect>
        <FilterSelect id="filter-year" label="Year" value={query.year || ''} onChange={(value) => handleFilterChange('year', value)}>
          <option value="">All years</option>
          {availableYears.map((year) => <option key={year} value={year}>{year}</option>)}
        </FilterSelect>
        <FilterSelect id="filter-program" label="Program" value={query.program || ''} onChange={(value) => handleFilterChange('program', value)}>
          <option value="">All programs</option>
          {availablePrograms.map((program) => <option key={program} value={program}>{program}</option>)}
        </FilterSelect>
        <FilterSelect id="filter-discipline" label="Discipline" value={query.discipline || ''} onChange={(value) => handleFilterChange('discipline', value)}>
          <option value="">All disciplines</option>
          {availableDisciplines.map((discipline) => <option key={discipline} value={discipline}>{discipline}</option>)}
        </FilterSelect>
        <FilterSelect id="filter-pagesize" label="Page size" value={String(query.pageSize || 10)} onChange={(value) => handleFilterChange('pageSize', value)} className="col-span-2 sm:col-span-1">
          <option value="10">10 per page</option>
          <option value="25">25 per page</option>
          <option value="50">50 per page</option>
        </FilterSelect>
      </div>
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  className = '',
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-[44px] rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {children}
      </select>
    </div>
  );
}
