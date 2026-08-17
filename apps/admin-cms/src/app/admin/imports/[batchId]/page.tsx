import React from 'react';
import Link from 'next/link';
import { Folder, Calendar, ChevronRight, CheckCircle2, XCircle, Info } from 'lucide-react';
import { ImportBatchRepository } from '../../../../repositories/ImportBatchRepository';
import ImportBatchStatusBadge from '../../../../components/admin/ImportBatchStatusBadge';
import { ImportBatchReviewPanel, ImportBatchReviewProjectView } from '../../../../components/admin/ImportBatchReviewPanel';
import {
  ImportBatchRow,
  ImportBatchReviewProjectRow,
} from '../../../../repositories/ImportBatchRepositoryCore';
import { computeReadinessForImportBatchRow, isPrivateAssetPresent } from '../../../../import/importBatchReviewReadiness';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../../components/ui/card';
import { ErrorState } from '../../../../components/ui/error-state';

export const dynamic = 'force-dynamic';

export default async function ImportBatchDetailPage({
  params
}: {
  params: Promise<{ batchId: string }>
}) {
  const { batchId } = await params;
  let batch: ImportBatchRow | null = null;
  let reviewRows: ImportBatchReviewProjectRow[] = [];
  let canSubmit = false;

  let errorMsg: string | null = null;

  try {
    const repository = new ImportBatchRepository();
    const [batchResult, adminContext] = await Promise.all([
      repository.getImportBatchById(batchId),
      requireAdmin(),
    ]);
    batch = batchResult;
    canSubmit = hasPermission(adminContext.permissions, 'projects.edit');

    if (batch) {
      reviewRows = await repository.getImportBatchReviewData(batchId);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'database error';
    console.error('[Staging Batch Detail Load Error]:', message);
    errorMsg = message;
  }

  // Safe error card for load failure
  if (errorMsg) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full py-12">
        <ErrorState
          title="Import details unavailable"
          description="The requested import details could not be retrieved. Please try again."
          action={
            <Button asChild variant="outline">
              <Link href="/admin/imports">Return to Imports</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // Safe error card for missing batch
  if (!batch) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full py-12">
        <ErrorState
          title="Import not found"
          description="The requested import batch does not exist or has been removed."
          action={
            <Button asChild variant="outline">
              <Link href="/admin/imports">Return to Imports</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const reviewProjects: ImportBatchReviewProjectView[] = reviewRows.map((row) => {
    const readiness = computeReadinessForImportBatchRow(row);
    const mediaAssets = (row.media_assets || []).map((a) => ({
      assetType: a.asset_type,
      isPublicApproved: a.is_public_approved,
      publicUrl: a.public_url,
      altText: a.alt_text_public,
    }));
    const posterPresent = isPrivateAssetPresent(mediaAssets, 'poster_image');
    const posterPdfPresent = isPrivateAssetPresent(mediaAssets, 'poster_pdf');
    return {
      publicId: row.public_id,
      title: row.title || '(untitled)',
      status: row.status,
      eligibility: readiness.eligibility,
      ready: readiness.ready,
      blockingReasons: readiness.blockingReasons,
      warnings: readiness.warnings,
      posterPresent,
      posterPdfPresent,
    };
  });

  // Authoritative summary metrics: batch total projects and actionable review counts
  const totalImported = batch.total_projects;
  const readyToSubmitCount = reviewProjects.filter((p) => p.eligibility === 'eligible' && p.ready).length;
  const needsFixesCount = reviewProjects.filter((p) => p.eligibility === 'eligible' && !p.ready).length;

  // Reset client-side selection whenever the authoritative selectable project set or workflow state changes.
  // A React key remount avoids synchronously setting state from an effect while still guaranteeing stale
  // selections cannot survive a server refresh that changes readiness, eligibility, status, or membership.
  const reviewSelectionKey = [
    batch.status,
    ...reviewProjects.map((project) =>
      `${project.publicId}:${project.status}:${project.eligibility}:${project.ready ? 'ready' : 'blocked'}`
    ),
  ].join('|');

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold tracking-tight text-foreground break-words">
              {batch.batch_name || 'Import batch'}
            </h2>
            <ImportBatchStatusBadge status={batch.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1 min-w-0">
              <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <code className="font-mono break-all">{batch.source_folder}</code>
            </span>
            <span className="flex items-center gap-1 shrink-0">
              <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
              {new Date(batch.created_at).toLocaleString()}
            </span>
          </div>
        </div>

        <div className="shrink-0">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/imports">
              All imports
            </Link>
          </Button>
        </div>
      </div>

      {/* Outcome Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border rounded-lg border border-border bg-card">
        <div className="p-4 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
            <Folder className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Projects imported</p>
            <p className="text-xl font-bold text-foreground">{totalImported}</p>
          </div>
        </div>

        <div className="p-4 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-success/10 text-success shrink-0">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Ready to submit</p>
            <p className="text-xl font-bold text-success">{readyToSubmitCount}</p>
          </div>
        </div>

        <div className="p-4 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-warning/10 text-warning shrink-0">
            <XCircle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Need fixes</p>
            <p className="text-xl font-bold text-warning">{needsFixesCount}</p>
          </div>
        </div>
      </div>

      {/* Main Content Layout: fixed-width metadata rail + fluid review surface */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
        {/* Left Rail: Import Summary (secondary, compact) */}
        <Card className="bg-card border-border shadow-xs">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm font-semibold text-foreground">
              Import summary
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 flex flex-col gap-3.5 text-xs">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Source Folder
              </span>
              <span className="font-mono text-xs text-foreground bg-muted p-2 rounded-md break-all">
                {batch.source_folder}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Import Type
              </span>
              <span className="text-foreground capitalize">
                {batch.mode}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Projects Count
              </span>
              <span className="font-semibold text-foreground">
                {batch.total_projects} project(s)
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Validation Issues
              </span>
              <span className="text-foreground">
                {batch.error_count || 0} error(s), {batch.warning_count || 0} warning(s)
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Imported on
              </span>
              <span className="text-foreground">
                {new Date(batch.created_at).toLocaleString()}
              </span>
            </div>

            {/* Native Disclosure for Technical Details */}
            <details className="mt-1 pt-3 border-t border-border group">
              <summary className="text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer flex items-center justify-between list-none">
                <span>Advanced details</span>
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
              </summary>
              <div className="mt-2 text-xs font-mono text-muted-foreground bg-muted/60 p-2.5 rounded-md break-all">
                <span className="font-semibold text-foreground block mb-0.5 font-sans">Batch UUID:</span>
                {batch.id}
              </div>
            </details>

            {/* Staging Safety Notice */}
            <div className="mt-1 pt-3 border-t border-border text-xs text-muted-foreground leading-relaxed flex items-start gap-2">
              <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                {batch.status === 'metadata_staged'
                  ? 'Project details have been saved in the test environment. Media files have not finished importing yet, so these projects cannot be submitted for review.'
                  : 'Project files are stored privately in the test environment. Nothing from this import is published to the public showcase website.'}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Primary Workspace: Ingested Projects Review Surface */}
        <Card className="bg-card border-border shadow-xs">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-base font-semibold text-foreground">
              Projects in this import ({reviewProjects.length})
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Review project readiness and submit verified projects for review.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            {reviewProjects.length > 0 ? (
              <ImportBatchReviewPanel
                key={reviewSelectionKey}
                batchId={batch.id}
                batchStatus={batch.status}
                projects={reviewProjects}
                canSubmit={canSubmit}
              />
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No projects are registered for this batch.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
