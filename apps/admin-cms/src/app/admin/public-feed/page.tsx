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
    return <ErrorState title="Public feed history unavailable" description="Deployment evidence could not be loaded. Try again shortly." headingLevel="h1" />;
  }

  const env = getServerEnv();
  const canPublish = canPreparePublication(admin.permissions);
  const rollbackAvailable = view.rollbackEnabled
    && isLocalPublicFeedRollbackAvailable(env.supabaseUrl, process.env);

  return (
    <div className="flex flex-col gap-8">
      <header className="max-w-4xl">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Public deployment history</h1>
          <Badge variant={view.active ? 'success' : 'warning'}>{view.active ? 'Ledger active' : 'Activation required'}</Badge>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Lifecycle status describes editorial workflow. Deployment status describes the immutable version currently served from the canonical public feed.
        </p>
      </header>

      {view.blockingOperation && (
        <section aria-labelledby="feed-operation-status" className="rounded-xl border border-warning/40 bg-warning/5 p-5">
          <h2 id="feed-operation-status" className="font-semibold text-foreground">Feed operation requires attention</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {view.blockingOperation.kind} is {view.blockingOperation.state.toLowerCase().replaceAll('_', ' ')}.
            {view.blockingOperation.failureCode ? ` Recovery code: ${view.blockingOperation.failureCode}.` : ''}
          </p>
        </section>
      )}

      <dl className="grid overflow-hidden rounded-xl border border-border-structural bg-card shadow-xs sm:grid-cols-3">
        <div className="border-b border-border/80 px-5 py-4 sm:border-b-0 sm:border-r"><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current version</dt><dd className="mt-1 text-2xl font-semibold">{view.currentVersionNumber ?? '—'}</dd></div>
        <div className="border-b border-border/80 px-5 py-4 sm:border-b-0 sm:border-r"><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Head generation</dt><dd className="mt-1 text-2xl font-semibold">{view.generation ?? '—'}</dd></div>
        <div className="px-5 py-4"><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rollback capability</dt><dd className="mt-1 text-sm font-semibold">{rollbackAvailable ? 'Disposable Local enabled' : 'Unavailable'}</dd></div>
      </dl>

      <PublicFeedHistoryControls
        canPublish={canPublish} historyActive={view.active} rollbackAvailable={rollbackAvailable}
        targetVersionNumber={view.detail?.versionNumber ?? null} targetIsCurrent={view.detail?.current ?? false}
        recoveryAvailable={Boolean(view.blockingOperation)}
      />

      <section aria-labelledby="feed-versions-heading" className="space-y-3">
        <h2 id="feed-versions-heading" className="text-lg font-semibold">Immutable versions</h2>
        {view.versions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No public deployment versions exist yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border-structural bg-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-4 py-3">Version</th><th className="px-4 py-3">Operation</th><th className="px-4 py-3">Time</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3">Records</th><th className="px-4 py-3">SHA-256</th></tr>
              </thead>
              <tbody className="divide-y divide-border/80">
                {view.versions.map((item) => (
                  <tr key={item.versionNumber}>
                    <td className="px-4 py-3 font-semibold"><Link className="text-primary underline-offset-4 hover:underline" href={`/admin/public-feed?page=${view.page}&version=${item.versionNumber}`}>v{item.versionNumber}</Link>{item.current && <Badge variant="success" className="ml-2">Current</Badge>}</td>
                    <td className="px-4 py-3 capitalize">{item.operation}{item.publicationMode ? ` · ${item.publicationMode.replaceAll('_', ' ')}` : ''}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatTimestamp(item.createdAt)}</td>
                    <td className="px-4 py-3">{item.actorDisplay}</td>
                    <td className="px-4 py-3 tabular-nums">{item.recordCount}</td>
                    <td className="px-4 py-3 font-mono text-xs" title={item.feedHash}>{item.feedHash.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <PublicFeedHistoryPagination page={view.page} hasNewer={view.hasNewer} hasOlder={view.hasOlder} />
      </section>

      {view.detail && (
        <section aria-labelledby="version-detail-heading" className="rounded-xl border border-border-structural bg-card p-5 shadow-xs">
          <h2 id="version-detail-heading" className="text-lg font-semibold">Version {view.detail.versionNumber} evidence</h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="font-medium text-muted-foreground">Relationship</dt><dd>{view.detail.previousVersionNumber ? `After version ${view.detail.previousVersionNumber}` : 'Initial baseline'}</dd></div>
            <div><dt className="font-medium text-muted-foreground">Rollback origin</dt><dd>{view.detail.restoredFromVersionNumber ? `Restored version ${view.detail.restoredFromVersionNumber}` : 'Not a rollback'}</dd></div>
            <div><dt className="font-medium text-muted-foreground">Affected project</dt><dd>{view.detail.affectedPublicId ? `${view.detail.affectedPublicId}${view.detail.affectedTitle ? ` — ${view.detail.affectedTitle}` : ''}` : 'Deployment-wide'}</dd></div>
            <div><dt className="font-medium text-muted-foreground">Exact byte count</dt><dd>{view.detail.byteCount.toLocaleString('en-AU')}</dd></div>
            <div className="sm:col-span-2"><dt className="font-medium text-muted-foreground">SHA-256</dt><dd className="break-all font-mono text-xs">{view.detail.feedHash}</dd></div>
          </dl>
          <h3 className="mt-6 font-semibold">Membership and drift</h3>
          <ul className="mt-3 divide-y divide-border/80 rounded-lg border border-border">
            {view.detail.members.map((member) => (
              <li key={member.publicId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span><span className="font-medium">{member.publicId}</span>{member.title ? ` — ${member.title}` : ''}</span>
                <span className="text-muted-foreground">Lifecycle {member.lifecycleStatus} · {member.currentlyDeployed ? 'currently deployed' : 'not currently deployed'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="deployment-status-heading" className="space-y-3">
        <h2 id="deployment-status-heading" className="text-lg font-semibold">Lifecycle versus current deployment</h2>
        <div className="overflow-x-auto rounded-xl border border-border-structural bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40"><tr><th className="px-4 py-3">Project</th><th className="px-4 py-3">Lifecycle</th><th className="px-4 py-3">Deployment</th><th className="px-4 py-3">Action</th></tr></thead>
            <tbody className="divide-y divide-border/80">
              {view.deploymentStatuses.map((item) => <tr key={item.publicId}><td className="px-4 py-3"><span className="font-medium">{item.publicId}</span> — {item.title}</td><td className="px-4 py-3 capitalize">{item.lifecycleStatus}</td><td className="px-4 py-3">{item.deployed ? 'Deployed' : 'Not deployed'}</td><td className="px-4 py-3">{canPublish && item.lifecycleStatus === 'published' && !item.deployed ? <DeploymentReconciliationButton publicId={item.publicId} /> : '—'}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
