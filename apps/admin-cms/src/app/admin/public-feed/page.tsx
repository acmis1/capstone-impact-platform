import Link from 'next/link';
import { requireAdmin } from '../../../auth/requireAdmin';
import { canPreparePublication } from '../../../auth/permissions';
import { getServerEnv } from '../../../lib/env';
import { createSupabaseAdminClient } from '../../../lib/supabase/admin';
import { isLocalPublicFeedRollbackAvailable } from '../../../projects/localPublicationExecution';
import { readPublicFeedHistory, type PublicFeedHistoryView } from '../../../projects/publicFeedHistoryRepository';
import { PublicFeedHistoryControls } from '../../../components/admin/PublicFeedHistoryControls';
import { PublicFeedHistoryPagination } from '../../../components/admin/PublicFeedHistoryPagination';
import { DeploymentReconciliationButton } from '../../../components/admin/DeploymentReconciliationButton';
import { Badge } from '../../../components/ui/badge';
import { ErrorState } from '../../../components/ui/error-state';

export const dynamic = 'force-dynamic';

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
}

function isDeploymentReconciliation(operation: string, mode?: string | null): boolean {
  return operation === 'publication' && mode === 'deployment_reconciliation';
}

export function translateOperation(operation: string, mode?: string | null): string {
  if (operation === 'baseline') return 'Initial setup';
  if (operation === 'removal') return 'Removed';
  if (operation === 'rollback') return 'Restored';
  if (operation === 'publication') {
    if (isDeploymentReconciliation(operation, mode)) return 'Showcase status repaired';
    return 'Published';
  }
  return 'Showcase update';
}

export default async function PublicFeedHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ version?: string; page?: string }>;
}) {
  const admin = await requireAdmin();
  const query = await searchParams;
  const requested = Number(query.version);
  const selectedVersion = Number.isSafeInteger(requested) && requested > 0 ? requested : undefined;
  const requestedPage = Number(query.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  let view: PublicFeedHistoryView | null = null;
  try {
    view = await readPublicFeedHistory(createSupabaseAdminClient(), selectedVersion, page);
  } catch {
    console.error('[Public feed history]: HISTORY_READ_FAILED');
  }
  if (!view) {
    return <ErrorState title="Showcase publishing history unavailable" description="Publishing activity could not be loaded. Try again shortly." headingLevel="h1" />;
  }

  const env = getServerEnv();
  const canPublish = canPreparePublication(admin.permissions);
  const rollbackAvailable = view.rollbackEnabled
    && isLocalPublicFeedRollbackAvailable(env.supabaseUrl, process.env);

  const projectsPublishedCount = view.deploymentStatuses.filter((s) => s.deployed).length;
  const divergedProjectsCount = view.deploymentStatuses.filter((s) => s.lifecycleStatus === 'published' && !s.deployed).length;
  const hasDivergedProjects = divergedProjectsCount > 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="max-w-4xl">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Showcase publishing history</h1>
          <Badge variant={view.active ? 'success' : 'warning'}>{view.active ? 'Publishing ready' : 'Setup required'}</Badge>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Publish or remove individual projects from their project page. This page shows showcase publishing activity and system status.
        </p>
      </header>

      {view.blockingOperation && (
        <section aria-labelledby="publishing-attention-status" className="rounded-xl border border-warning/40 bg-warning/5 p-5 shadow-xs">
          <h2 id="publishing-attention-status" className="font-semibold text-foreground">Publishing needs attention</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A previous publishing action did not finish cleanly. Publishing is paused until it is safely recovered.
          </p>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Technical details</summary>
            <p className="mt-1 font-mono">
              {view.blockingOperation.kind} is {view.blockingOperation.state.toLowerCase().replaceAll('_', ' ')}.
              {view.blockingOperation.failureCode ? ` Recovery code: ${view.blockingOperation.failureCode}.` : ''}
            </p>
          </details>
        </section>
      )}

      {/* Top-Level Status Summary Cards */}
      <dl className="grid overflow-hidden rounded-xl border border-border-structural bg-card shadow-xs sm:grid-cols-3">
        <div className="border-b border-border/80 px-5 py-4 sm:border-b-0 sm:border-r">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Publishing status</dt>
          <dd className="mt-1 text-lg font-semibold text-foreground">
            {view.blockingOperation ? 'Needs attention' : view.active ? 'Ready' : 'Setup required'}
          </dd>
        </div>
        <div className="border-b border-border/80 px-5 py-4 sm:border-b-0 sm:border-r">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Projects published</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{projectsPublishedCount}</dd>
        </div>
        <div className="px-5 py-4">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status alignment</dt>
          <dd className="mt-1 text-sm font-medium text-foreground">
            {view.blockingOperation
              ? 'Recovery required'
              : hasDivergedProjects
                ? `${divergedProjectsCount} ${divergedProjectsCount === 1 ? 'project needs repair' : 'projects need repair'}`
                : 'All projects in sync'}
          </dd>
        </div>
      </dl>

      {/* Progressive Disclosure for Technical Evidence */}
      <details className="rounded-xl border border-border-structural bg-card p-4 text-xs text-muted-foreground shadow-xs">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">Advanced publishing details</summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="font-medium text-muted-foreground">Current version</dt>
            <dd className="mt-0.5 font-mono text-sm text-foreground">{view.currentVersionNumber ? `v${view.currentVersionNumber}` : '—'}</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Head generation</dt>
            <dd className="mt-0.5 font-mono text-sm text-foreground">{view.generation ?? '—'}</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Rollback capability</dt>
            <dd className="mt-0.5 text-sm text-foreground">{rollbackAvailable ? 'Disposable Local enabled' : 'Unavailable in hosted staging'}</dd>
          </div>
        </dl>
      </details>

      <PublicFeedHistoryControls
        canPublish={canPublish} historyActive={view.active} rollbackAvailable={rollbackAvailable}
        targetVersionNumber={view.detail?.versionNumber ?? null} targetIsCurrent={view.detail?.current ?? false}
        recoveryAvailable={Boolean(view.blockingOperation)}
      />

      {/* Publishing Activity Table */}
      <section aria-labelledby="publishing-activity-heading" className="space-y-3">
        <h2 id="publishing-activity-heading" className="text-lg font-semibold text-foreground">Publishing activity</h2>
        {view.versions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No publishing activity recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border-structural bg-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Activity</th>
                  <th className="px-4 py-3">Project</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">By</th>
                  <th className="px-4 py-3">Projects published</th>
                  <th className="px-4 py-3">Version</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/80">
                {view.versions.map((item) => (
                  <tr key={item.versionNumber}>
                    <td className="px-4 py-3 font-medium text-foreground">
                      {translateOperation(item.operation, item.publicationMode)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.affectedPublicId ? item.affectedPublicId : (item.operation === 'baseline' ? 'Initial setup' : '—')}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatTimestamp(item.createdAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{item.actorDisplay}</td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{item.recordCount}</td>
                    <td className="px-4 py-3 font-semibold">
                      <Link className="text-primary underline-offset-4 hover:underline" href={`/admin/public-feed?page=${view.page}&version=${item.versionNumber}`}>
                        v{item.versionNumber}
                      </Link>
                      {item.current && <Badge variant="success" className="ml-2">Current</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PublicFeedHistoryPagination page={view.page} hasNewer={view.hasNewer} hasOlder={view.hasOlder} />
      </section>

      {/* Selected Version / Activity Details */}
      {view.detail && (
        <section aria-labelledby="activity-detail-heading" className="rounded-xl border border-border-structural bg-card p-5 shadow-xs">
          <h2 id="activity-detail-heading" className="text-lg font-semibold text-foreground">
            Activity details (Version {view.detail.versionNumber})
          </h2>
          <div className="mt-3 text-sm text-foreground">
            <p className="font-medium">
              {view.detail.operation === 'baseline' && 'Initial showcase setup'}
              {view.detail.operation === 'publication' && (isDeploymentReconciliation(view.detail.operation, view.detail.publicationMode)
                ? `Repaired showcase status for ${view.detail.affectedTitle || view.detail.affectedPublicId || ''}`
                : `Published project ${view.detail.affectedTitle || view.detail.affectedPublicId || ''}`)}
              {view.detail.operation === 'removal' && `Removed project ${view.detail.affectedTitle || view.detail.affectedPublicId || ''}`}
              {view.detail.operation === 'rollback' && `Restored version ${view.detail.restoredFromVersionNumber}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Performed by {view.detail.actorDisplay} on {formatTimestamp(view.detail.createdAt)} · {view.detail.recordCount} {view.detail.recordCount === 1 ? 'project' : 'projects'} published
            </p>
          </div>

          <details className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Technical details</summary>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="font-medium text-muted-foreground">Publication mode</dt><dd className="mt-0.5 font-mono text-foreground">{view.detail.publicationMode ?? 'standard'}</dd></div>
              <div><dt className="font-medium text-muted-foreground">Relationship</dt><dd className="mt-0.5 text-foreground">{view.detail.previousVersionNumber ? `After version ${view.detail.previousVersionNumber}` : 'Initial baseline'}</dd></div>
              <div><dt className="font-medium text-muted-foreground">Rollback origin</dt><dd className="mt-0.5 text-foreground">{view.detail.restoredFromVersionNumber ? `Restored version ${view.detail.restoredFromVersionNumber}` : 'Not a rollback'}</dd></div>
              <div><dt className="font-medium text-muted-foreground">Affected project</dt><dd className="mt-0.5 text-foreground">{view.detail.affectedPublicId ? `${view.detail.affectedPublicId}${view.detail.affectedTitle ? ` — ${view.detail.affectedTitle}` : ''}` : 'Deployment-wide'}</dd></div>
              <div><dt className="font-medium text-muted-foreground">Exact byte count</dt><dd className="mt-0.5 text-foreground">{view.detail.byteCount.toLocaleString('en-AU')} bytes</dd></div>
              <div className="sm:col-span-2"><dt className="font-medium text-muted-foreground">SHA-256 integrity hash</dt><dd className="mt-0.5 break-all font-mono text-xs text-foreground">{view.detail.feedHash}</dd></div>
            </dl>
          </details>

          <div className="mt-5 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-foreground">Projects in this version</h3>
            <ul className="mt-3 divide-y divide-border/80 rounded-lg border border-border">
              {view.detail.members.map((member) => (
                <li key={member.publicId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span>
                    <span className="font-medium text-foreground">{member.publicId}</span>
                    {member.title ? ` — ${member.title}` : ''}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant={member.currentlyDeployed ? 'success' : 'neutral'}>
                      {member.currentlyDeployed ? 'Published' : 'Not published'}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Project Publishing Status Table */}
      <section aria-labelledby="project-publishing-status-heading" className="space-y-3">
        <div>
          <h2 id="project-publishing-status-heading" className="text-lg font-semibold text-foreground">Project publishing status</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Review each project&apos;s workflow stage and publication status.
          </p>
        </div>

        {hasDivergedProjects && (
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-foreground shadow-xs">
            <strong className="font-semibold text-warning">Publishing status needs attention:</strong> One or more projects are marked as published in the CMS but are missing from the current published data. Use &ldquo;Repair showcase status&rdquo; to resolve.
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-border-structural bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Project</th>
                <th className="px-4 py-3">Workflow status</th>
                <th className="px-4 py-3">Publishing status</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/80">
              {view.deploymentStatuses.map((item) => (
                <tr key={item.publicId}>
                  <td className="px-4 py-3">
                    <Link href={`/admin/projects/${encodeURIComponent(item.publicId)}`} className="font-medium text-primary hover:underline">
                      {item.publicId}
                    </Link>
                    {item.title ? ` — ${item.title}` : ''}
                  </td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{item.lifecycleStatus.replaceAll('_', ' ')}</td>
                  <td className="px-4 py-3">
                    <Badge variant={item.deployed ? 'success' : 'neutral'}>
                      {item.deployed ? 'Published' : 'Not published'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {canPublish && item.lifecycleStatus === 'published' && !item.deployed ? (
                      <DeploymentReconciliationButton publicId={item.publicId} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
