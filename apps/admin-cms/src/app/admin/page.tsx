import React from 'react';
import Link from 'next/link';
import { Plus, FolderOpen } from 'lucide-react';
import { SupabaseProjectRepository } from '../../repositories/SupabaseProjectRepository';
import {
  parseProjectListQuery,
  ProjectListResult,
  ProjectDashboardMetrics,
  ProjectFilterOptions,
} from '../../domain/projectQuery';
import { requireAdmin } from '../../auth/requireAdmin';
import { hasPermission } from '../../auth/permissions';
import { DashboardMetricsSummary } from '../../components/admin-dashboard/DashboardMetricsSummary';
import { ProjectFilterBar } from '../../components/admin-dashboard/ProjectFilterBar';
import { ProjectTableContainer } from '../../components/admin-dashboard/ProjectTableContainer';
import { NoMatchingProjectsState } from '../../components/admin-dashboard/NoMatchingProjectsState';
import { DashboardPreferencesProvider } from '../../components/admin-dashboard/useDashboardPreferences';
import { Button } from '../../components/ui/button';
import { ErrorState } from '../../components/ui/error-state';
import { EmptyState } from '../../components/ui/empty-state';
import { BulkProjectReviewBusyProvider } from '../../components/admin-dashboard/BulkProjectReviewBusyContext';

import {
  toProjectIndexRow,
  ProjectIndexResult,
} from '../../components/admin-dashboard/projectDashboardHelpers';

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
  let canImport = false;
  let canSubmitBulk = false;
  let canReviewBulk = false;

  try {
    const authContext = await requireAdmin();
    canImport = hasPermission(authContext.permissions, 'projects.edit');
    canSubmitBulk = hasPermission(authContext.permissions, 'projects.edit');
    canReviewBulk = hasPermission(authContext.permissions, 'projects.review');
  } catch {
    // The admin layout already guards this route; an unavailable permission context
    // only means the contextual import action stays hidden.
  }

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

  const clientResult: ProjectIndexResult | null = result
    ? {
        rows: result.projects.map(toProjectIndexRow),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        pageCount: result.pageCount,
      }
    : null;

  const hasActiveFilters = Boolean(
    query.search || query.status || query.year || query.program || query.discipline
  );

  const resultContext = clientResult
    ? `${clientResult.total.toLocaleString()} ${
        hasActiveFilters
          ? clientResult.total === 1 ? 'matching project record' : 'matching project records'
          : clientResult.total === 1 ? 'project record' : 'project records'
      }`
    : null;

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Projects
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Search, review and open capstone project records.
          </p>
          {resultContext && (
            <p className="text-sm font-medium text-foreground-subtle">{resultContext}</p>
          )}
        </div>

        {canImport && (
          <div className="shrink-0">
            <Button asChild>
              <Link href="/admin/imports/new">
                <Plus aria-hidden="true" />
                New import
              </Link>
            </Button>
          </div>
        )}
      </div>

      {loadError || !clientResult || !metrics ? (
        <ErrorState
          title="Projects could not be loaded"
          description="The requested project index information could not be retrieved from the database. Try again or contact the system administrator."
          action={
            <Button asChild className="min-h-[44px]">
              <Link href="/admin">Reload page</Link>
            </Button>
          }
        />
      ) : (
        <>
          <DashboardMetricsSummary metrics={metrics} />

          <DashboardPreferencesProvider>
            <BulkProjectReviewBusyProvider>
              <ProjectFilterBar
                query={query}
                availableYears={filterOptions.years}
                availablePrograms={filterOptions.programs}
                availableDisciplines={filterOptions.disciplines}
              />

              {clientResult.total === 0 ? (
                hasActiveFilters ? (
                  <NoMatchingProjectsState query={query} />
                ) : (
                  <EmptyState
                    icon={FolderOpen}
                    title="No project records available"
                    description="There are currently no active capstone project records stored in the staging database repository."
                    action={
                      canImport ? (
                        <Button asChild className="min-h-[44px]">
                          <Link href="/admin/imports/new">
                            <Plus aria-hidden="true" />
                            New import
                          </Link>
                        </Button>
                      ) : undefined
                    }
                  />
                )
              ) : (
                <ProjectTableContainer
                  query={query}
                  result={clientResult}
                  canSubmitBulk={canSubmitBulk}
                  canReviewBulk={canReviewBulk}
                />
              )}
            </BulkProjectReviewBusyProvider>
          </DashboardPreferencesProvider>
        </>
      )}
    </div>
  );
}
