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

export const dynamic = 'force-dynamic';

export default async function ImportBatchesPage() {
  let batches: ImportBatchRow[] = [];
  let loadError = false;
  let canEdit = false;

  try {
    const authContext = await requireAdmin();
    canEdit = hasPermission(authContext.permissions, 'projects.edit');
  } catch {
    // Non-blocking for audit log display if authenticated
  }

  try {
    const repository = new ImportBatchRepository();
    batches = await repository.listRecentImportBatches(50);
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
          <ImportMetricsSummary metrics={summaryMetrics} />

          {/* Import Batches Table Card */}
          <Card className="border-border-structural">
            <CardHeader className="border-b border-border py-4 px-6">
              <CardTitle className="text-base font-semibold text-foreground">
                Recent imports
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {batches.length === 0 ? (
                <div className="py-12">
                  <EmptyState
                    icon={FileSpreadsheet}
                    title="No imports found"
                    description="No project import batches have been recorded yet."
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
        </>
      )}
    </div>
  );
}
