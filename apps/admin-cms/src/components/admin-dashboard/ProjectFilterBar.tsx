'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';

import type { PageSizeOption, ProjectListQuery } from '../../domain/projectQuery';
import type { WorkflowStatus } from '../../domain/workflowStatus';
import { Button } from '../ui/button';
import { OPERATIONAL_SURFACE_CLASS_NAME } from '../ui/card';
import { getWorkflowStatusLabel } from '../admin/ProjectStatusBadge';
import { cn } from '../../lib/utils';
import {
  buildClearFiltersQueryString,
  buildQueryString,
  CLEARED_FILTER_PREFERENCES,
} from './filterQueryHelpers';
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

type FilterKey = 'status' | 'year' | 'program' | 'discipline';

const FILTER_LABELS: Record<FilterKey, string> = {
  status: 'Status',
  year: 'Year',
  program: 'Program',
  discipline: 'Discipline',
};

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
  const [filtersExpanded, setFiltersExpanded] = React.useState(false);

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

  const handleClearSearch = () => {
    setSearchInput('');
    const queryString = buildQueryString(rawSearchParams, { q: null, search: null });
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
    updatePreferences({ ...CLEARED_FILTER_PREFERENCES });
    const queryString = buildClearFiltersQueryString(rawSearchParams);
    router.push(navigationHref(pathname, new URLSearchParams(queryString)));
  };

  const handleResetPreferences = () => {
    resetPreferences();
    const params = new URLSearchParams(rawSearchParams);
    for (const key of PREFERENCE_QUERY_KEYS) params.delete(key);
    params.delete('page');
    // Search remains transient: Reset view intentionally preserves it.
    router.push(navigationHref(pathname, params));
  };

  const activeFilters: Array<{ key: FilterKey; value: string; display: string }> = [];
  if (query.status) {
    activeFilters.push({
      key: 'status',
      value: query.status,
      display: getWorkflowStatusLabel(query.status),
    });
  }
  if (query.year) activeFilters.push({ key: 'year', value: query.year, display: query.year });
  if (query.program) {
    activeFilters.push({ key: 'program', value: query.program, display: query.program });
  }
  if (query.discipline) {
    activeFilters.push({ key: 'discipline', value: query.discipline, display: query.discipline });
  }

  const hasActiveFilters = Boolean(query.search) || activeFilters.length > 0;

  return (
    <section
      aria-labelledby="project-discovery-heading"
      className={`${OPERATIONAL_SURFACE_CLASS_NAME} overflow-hidden`}
    >
      <h3 id="project-discovery-heading" className="sr-only">
        Find projects
      </h3>

      <div className="flex flex-col gap-4 p-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-col gap-2">
          <label htmlFor="project-search" className="text-sm font-semibold text-foreground">
            Search projects
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                id="project-search"
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search by title, public ID, partner, or group..."
                aria-describedby="project-search-hint"
                maxLength={100}
                className="min-h-[44px] w-full rounded-md border border-input bg-background py-2 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              />
            </div>
            <Button type="submit" variant="default" className="min-h-[44px] sm:w-32">
              Search
            </Button>
          </div>
          <p id="project-search-hint" className="text-xs text-muted-foreground">
            Matches project title, public ID, industry partner and group name. Select Search to apply.
          </p>
        </form>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setFiltersExpanded((expanded) => !expanded)}
            aria-expanded={filtersExpanded}
            aria-controls="project-filter-controls"
            className="inline-flex min-h-[44px] items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          >
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              <span>
                Filters
                {activeFilters.length > 0 ? ` (${activeFilters.length} applied)` : ''}
              </span>
            </span>
            <ChevronDown
              className={cn(
                'size-4 transition-transform duration-150',
                filtersExpanded && 'rotate-180'
              )}
              aria-hidden="true"
            />
          </button>

          <div
            id="project-filter-controls"
            className={cn(
              'grid gap-3 sm:grid-cols-2 lg:grid-cols-4',
              !filtersExpanded && 'hidden md:grid'
            )}
          >
            <FilterSelect
              id="filter-status"
              label="Status"
              value={query.status || ''}
              onChange={(value) => handleFilterChange('status', value)}
            >
              <option value="">All statuses</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {getWorkflowStatusLabel(status)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              id="filter-year"
              label="Year"
              value={query.year || ''}
              onChange={(value) => handleFilterChange('year', value)}
            >
              <option value="">All years</option>
              {availableYears.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </FilterSelect>
            <FilterSelect
              id="filter-program"
              label="Program"
              value={query.program || ''}
              onChange={(value) => handleFilterChange('program', value)}
            >
              <option value="">All programs</option>
              {availablePrograms.map((program) => (
                <option key={program} value={program}>{program}</option>
              ))}
            </FilterSelect>
            <FilterSelect
              id="filter-discipline"
              label="Discipline"
              value={query.discipline || ''}
              onChange={(value) => handleFilterChange('discipline', value)}
            >
              <option value="">All disciplines</option>
              {availableDisciplines.map((discipline) => (
                <option key={discipline} value={discipline}>{discipline}</option>
              ))}
            </FilterSelect>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Active filters
            </h4>
            <div className="flex flex-wrap items-center gap-2">
              {query.search && (
                <FilterToken
                  label="Search"
                  value={query.search}
                  onRemove={handleClearSearch}
                />
              )}
              {activeFilters.map((filter) => (
                <FilterToken
                  key={filter.key}
                  label={FILTER_LABELS[filter.key]}
                  value={filter.display}
                  onRemove={() => handleFilterChange(filter.key, '')}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={handleClearFilters}
                className="min-h-[40px]"
              >
                Clear search and filters
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-border bg-surface-inset px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="filter-pagesize" className="text-sm font-medium text-muted-foreground">
            Rows per page
          </label>
          <select
            id="filter-pagesize"
            value={String(query.pageSize || 10)}
            onChange={(event) => handleFilterChange('pageSize', event.target.value)}
            className="min-h-[40px] rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
          </select>
        </div>

        <div className="flex flex-col gap-1 sm:items-end">
          <Button
            type="button"
            variant="ghost"
            onClick={handleResetPreferences}
            className="min-h-[40px] self-start sm:self-auto"
          >
            Reset view
          </Button>
          <p className="max-w-md text-xs text-muted-foreground sm:text-right">
            Restores the default sort, rows per page, filter selections and table columns. Your
            current search term is kept.
          </p>
        </div>
      </div>
    </section>
  );
}

function FilterToken({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove(): void;
}) {
  return (
    <span className="inline-flex min-h-[40px] max-w-full items-center gap-1.5 rounded-md border border-border bg-muted py-1 pl-2.5 pr-1 text-sm text-foreground">
      <span className="min-w-0 break-words">
        <span className="text-muted-foreground">{label}:</span> {value}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter: ${value}`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </span>
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
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-[44px] rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </select>
    </div>
  );
}
