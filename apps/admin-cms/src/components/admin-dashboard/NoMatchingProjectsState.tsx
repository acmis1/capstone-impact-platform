'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SearchX } from 'lucide-react';

import type { ProjectListQuery } from '../../domain/projectQuery';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { getWorkflowStatusLabel } from '../admin/ProjectStatusBadge';
import {
  buildClearFiltersQueryString,
  CLEARED_FILTER_PREFERENCES,
} from './filterQueryHelpers';
import { useDashboardPreferences } from './useDashboardPreferences';

export interface NoMatchingProjectsStateProps {
  query: ProjectListQuery;
}

/**
 * Filtered no-results state. The clear action performs exactly the same operation as the
 * filter bar's "Clear search and filters" control, so sort, direction, page size and column
 * visibility are preserved.
 */
export function NoMatchingProjectsState({ query }: NoMatchingProjectsStateProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { updatePreferences } = useDashboardPreferences();

  const context: string[] = [];
  if (query.search) context.push(`search "${query.search}"`);
  if (query.status) context.push(`status ${getWorkflowStatusLabel(query.status)}`);
  if (query.year) context.push(`year ${query.year}`);
  if (query.program) context.push(`program ${query.program}`);
  if (query.discipline) context.push(`discipline ${query.discipline}`);

  const description =
    context.length > 0
      ? `No project records match ${context.join(', ')}. Adjust or remove a filter to widen the results.`
      : 'No project records match the current search and filter criteria. Adjust or remove a filter to widen the results.';

  const handleClearFilters = () => {
    updatePreferences({ ...CLEARED_FILTER_PREFERENCES });
    const queryString = buildClearFiltersQueryString(searchParams?.toString() || '');
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  };

  return (
    <EmptyState
      icon={SearchX}
      title="No projects match your search or filters"
      description={description}
      action={
        <Button type="button" variant="outline" onClick={handleClearFilters} className="min-h-[44px]">
          Clear search and filters
        </Button>
      }
    />
  );
}
