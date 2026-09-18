import React from 'react';
import Link from 'next/link';
import { Plus, FileSpreadsheet } from 'lucide-react';
import { ImportBatchRepository } from '../../../repositories/ImportBatchRepository';
import ImportBatchTable from '../../../components/admin/ImportBatchTable';
import { ImportBatchRow } from '../../../repositories/ImportBatchRepositoryCore';
import { requireAdmin } from '../../../auth/requireAdmin';
import { hasPermission } from '../../../auth/permissions';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { getImportSummaryMetrics, ImportMetricsSummary } from '../../../components/admin/ImportMetricsSummary';
import { EmptyState } from '../../../components/ui/empty-state';
import { ErrorState } from '../../../components/ui/error-state';
import { ImportHistoryFilters, ImportHistoryPagination } from '../../../components/imports/ImportHistoryControls';
import { parseImportHistoryQuery, type ImportHistoryQuery } from '../../../import/importHistoryQuery';

export const dynamic = 'force-dynamic';

export default async function ImportBatchesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  let batches: ImportBatchRow[] = [];
  let loadError = false;
  let total = 0;
  let canEdit = false;

  let authContext: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    authContext = await requireAdmin();
  } catch {
    return (
      <ErrorState
        title="Import records unavailable"
        description="Your administrative session could not be verified. Sign in again to view import records."
        headingLevel="h1"
      />
    );
  }

  if (!hasPermission(authContext.permissions, 'projects.read')) {
    return (
      <ErrorState
        title="Access denied"
        description="Your account cannot view import records."
        headingLevel="h1"
      />
    );
  }

  canEdit = hasPermission(authContext.permissions, 'projects.edit');
  let query: ImportHistoryQuery;
  try { query = parseImportHistoryQuery(await searchParams ?? {}); } catch {
    return <ErrorState headingLevel="h1" title="Invalid import-history filters" description="Use a valid page, a four-digit import year, and a batch name up to 100 characters." action={<Button asChild variant="outline"><Link href="/admin/imports">Reset filters</Link></Button>} />;
  }

  try {
    const repository = new ImportBatchRepository();
    const result = await repository.listImportHistory(query);
    batches = result.batches;
    total = result.total;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown import batch load error';
    console.error('[Staging Import Batches Load Failure]:', message);
    loadError = true;
  }

  const summaryMetrics = getImportSummaryMetrics(batches);

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto w-full">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Imports
          </h1>
          <p className="text-sm text-muted-foreground">
            A record of project imports and their validation results.
          </p>
        </div>

        {canEdit && (
          <div className="shrink-0">
            <Button asChild>
              <Link href="/admin/imports/new">
                <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
                Import projects
              </Link>
            </Button>
          </div>
        )}
      </div>

      <ImportHistoryFilters query={query} />
      {loadError ? (
        <ErrorState
          title="Import records could not be loaded"
          description="Import records are temporarily unavailable. Please try again."
          action={
            <Button asChild variant="outline">
              <Link href="/admin/imports">Retry</Link>
            </Button>
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">The summary below covers the displayed page only.</p>
          <ImportMetricsSummary metrics={summaryMetrics} />

          {/* Import Batches Table Card */}
          <Card className="border-border-structural">
            <CardHeader className="border-b border-border py-4 px-6">
              <CardTitle className="text-base font-semibold text-foreground">
                Import history
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {batches.length === 0 ? (
                <div className="py-12">
                  <EmptyState
                    icon={FileSpreadsheet}
                    title="No imports found"
                    description={query.q || query.year || query.status || query.page > 1 ? "No imports match this page or filter selection. Adjust or clear the filters." : "No project import batches have been recorded yet."}
                    action={
                      canEdit ? (
                        <Button asChild>
                          <Link href="/admin/imports/new">
                            <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
                            Import projects
                          </Link>
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <ImportBatchTable batches={batches} />
              )}
            </CardContent>
          </Card>
          <ImportHistoryPagination query={query} total={total} />
        </>
      )}
    </div>
  );
}
