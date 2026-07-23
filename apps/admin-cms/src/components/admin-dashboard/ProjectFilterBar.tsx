'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { Button } from '../ui/button';
import { ProjectListQuery } from '../../domain/projectQuery';

import { buildQueryString } from './filterQueryHelpers';

export interface ProjectFilterBarProps {
  query: ProjectListQuery;
  availableYears: string[];
  availablePrograms: string[];
  availableDisciplines: string[];
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

  const [searchInput, setSearchInput] = React.useState(query.search || '');
  const [prevQuerySearch, setPrevQuerySearch] = React.useState(query.search);

  if (query.search !== prevQuerySearch) {
    setPrevQuerySearch(query.search);
    setSearchInput(query.search || '');
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const queryString = buildQueryString(searchParams?.toString() || '', { q: searchInput.trim() || null });
    router.push(`${pathname}?${queryString}`);
  };

  const handleFilterChange = (key: string, value: string) => {
    const queryString = buildQueryString(searchParams?.toString() || '', { [key]: value || null });
    router.push(`${pathname}?${queryString}`);
  };

  const handleClearFilters = () => {
    setSearchInput('');
    router.push(pathname);
  };

  const hasActiveFilters = Boolean(
    query.search ||
      query.status ||
      query.year ||
      query.program ||
      query.discipline
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs">
      <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by title, public ID, partner, or group..."
            aria-label="Search projects"
            className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 min-h-[44px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="default" className="min-h-[44px]">
            Search
          </Button>
          {hasActiveFilters && (
            <Button
              type="button"
              variant="outline"
              onClick={handleClearFilters}
              className="gap-1 min-h-[44px]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span>Clear</span>
            </Button>
          )}
        </div>
      </form>

      {/* Select Filters Row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {/* Status Filter */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status" className="text-xs font-semibold text-muted-foreground">
            Status
          </label>
          <select
            id="filter-status"
            value={query.status || ''}
            onChange={(e) => handleFilterChange('status', e.target.value)}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px]"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="in_review">In review</option>
            <option value="changes_requested">Changes requested</option>
            <option value="approved">Approved</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {/* Year Filter */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-year" className="text-xs font-semibold text-muted-foreground">
            Year
          </label>
          <select
            id="filter-year"
            value={query.year || ''}
            onChange={(e) => handleFilterChange('year', e.target.value)}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px]"
          >
            <option value="">All years</option>
            {availableYears.map((yr) => (
              <option key={yr} value={yr}>
                {yr}
              </option>
            ))}
          </select>
        </div>

        {/* Program Filter */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-program" className="text-xs font-semibold text-muted-foreground">
            Program
          </label>
          <select
            id="filter-program"
            value={query.program || ''}
            onChange={(e) => handleFilterChange('program', e.target.value)}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px]"
          >
            <option value="">All programs</option>
            {availablePrograms.map((prog) => (
              <option key={prog} value={prog}>
                {prog}
              </option>
            ))}
          </select>
        </div>

        {/* Discipline Filter */}
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-discipline" className="text-xs font-semibold text-muted-foreground">
            Discipline
          </label>
          <select
            id="filter-discipline"
            value={query.discipline || ''}
            onChange={(e) => handleFilterChange('discipline', e.target.value)}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px]"
          >
            <option value="">All disciplines</option>
            {availableDisciplines.map((disc) => (
              <option key={disc} value={disc}>
                {disc}
              </option>
            ))}
          </select>
        </div>

        {/* Page Size Filter */}
        <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
          <label htmlFor="filter-pagesize" className="text-xs font-semibold text-muted-foreground">
            Page Size
          </label>
          <select
            id="filter-pagesize"
            value={query.pageSize || 10}
            onChange={(e) => handleFilterChange('pageSize', e.target.value)}
            className="rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px]"
          >
            <option value="10">10 per page</option>
            <option value="25">25 per page</option>
            <option value="50">50 per page</option>
          </select>
        </div>
      </div>
    </div>
  );
}
