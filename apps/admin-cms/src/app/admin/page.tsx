import React from 'react';
import Link from 'next/link';
import { SupabaseProjectRepository } from '../../repositories/SupabaseProjectRepository';
import {
  parseProjectListQuery,
  ProjectListResult,
  ProjectDashboardMetrics,
  ProjectFilterOptions,
} from '../../domain/projectQuery';
import { DashboardMetricsCards } from '../../components/admin-dashboard/DashboardMetricsCards';
import { ProjectFilterBar } from '../../components/admin-dashboard/ProjectFilterBar';
import { ProjectTableContainer } from '../../components/admin-dashboard/ProjectTableContainer';
import { ErrorState } from '../../components/ui/error-state';
import { EmptyState } from '../../components/ui/empty-state';
import { FolderOpen, SearchX } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface AdminPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const rawParams = (await searchParams) || {};
  const query = parseProjectListQuery(rawParams);

  let result: ProjectListResult | null = null;
  let metrics: ProjectDashboardMetrics | null = null;
  let filterOptions: ProjectFilterOptions = { years: [], programs: [], disciplines: [] };
  let loadError: boolean = false;

  try {
    const repository = new SupabaseProjectRepository();
    const [fetchedResult, fetchedMetrics, fetchedOptions] = await Promise.all([
      repository.listProjectsPage(query),
      repository.getProjectDashboardMetrics(),
      repository.getProjectFilterOptions(),
    ]);

    result = fetchedResult;
    metrics = fetchedMetrics;
    filterOptions = fetchedOptions;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown database query failure';
    console.error('[Admin Project Index Query Error]:', message);
    loadError = true;
  }

  const hasActiveFilters = Boolean(
    query.search || query.status || query.year || query.program || query.discipline
  );

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 max-w-7xl mx-auto w-full">
      {/* Page Header */}
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Project Index & Operational Dashboard
        </h2>
        <p className="text-sm text-muted-foreground">
          Manage capstone project records, review state transitions, and showcase validation status.
        </p>
      </div>

      {loadError || !result || !metrics ? (
        <ErrorState
          title="Projects could not be loaded"
          description="The requested project index information could not be retrieved from the database. Try again or contact the system administrator."
          action={
            <Link
              href="/admin"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-2xs hover:bg-primary/90 min-h-[44px]"
            >
              Reload Page
            </Link>
          }
        />
      ) : (
        <>
          {/* Top Metrics Cards */}
          <DashboardMetricsCards metrics={metrics} />

          {/* Filter Bar */}
          <ProjectFilterBar
            query={query}
            availableYears={filterOptions.years}
            availablePrograms={filterOptions.programs}
            availableDisciplines={filterOptions.disciplines}
          />

          {/* Project List / Table Content */}
          {result.total === 0 ? (
            hasActiveFilters ? (
              <EmptyState
                icon={SearchX}
                title="No matching projects found"
                description="No project records match your active search term or filter criteria. Try adjusting or clearing your filters."
                action={
                  <Link
                    href="/admin"
                    className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-semibold text-foreground shadow-2xs hover:bg-accent hover:text-accent-foreground min-h-[44px]"
                  >
                    Clear all filters
                  </Link>
                }
              />
            ) : (
              <EmptyState
                icon={FolderOpen}
                title="No project records available"
                description="There are currently no active capstone project records stored in the staging database repository."
              />
            )
          ) : (
            <ProjectTableContainer query={query} result={result} />
          )}
        </>
      )}
    </div>
  );
}
