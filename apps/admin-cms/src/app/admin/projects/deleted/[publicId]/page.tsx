import Link from 'next/link';
import { requireAdmin } from '../../../../../auth/requireAdmin';
import { hasPermission } from '../../../../../auth/permissions';
import { ErrorState } from '../../../../../components/ui/error-state';
import { DeletedProjectRecoveryAction } from '../../../../../components/admin/DeletedProjectRecoveryAction';
import { SupabaseDeletedProjectMaintenanceGateway } from '../../../../../recovery/SupabaseDeletedProjectMaintenanceGateway';
import { createSupabaseAdminClient } from '../../../../../lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function DeletedProjectDetailPage({ params }: { params: Promise<{ publicId: string }> }) {
  const admin = await requireAdmin();
  if (!hasPermission(admin.permissions, 'projects.delete') || !admin.roles.includes('admin')) return <ErrorState title="Access denied" description="Your account cannot inspect deleted project records." headingLevel="h1" />;
  const { publicId } = await params;
  let detail;
  try { detail = await new SupabaseDeletedProjectMaintenanceGateway(createSupabaseAdminClient()).detail(publicId, admin.adminUserId); } catch { return <ErrorState title="Tombstone unavailable" description="The retained project detail could not be loaded." headingLevel="h1" />; }
  if (!detail) return <ErrorState title="Deleted project not found" description="No retained tombstone matched this identifier." headingLevel="h1" />;
  const { project, recovery } = detail;
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 pb-16">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground"><Link className="underline underline-offset-4" href="/admin">Projects</Link><span className="mx-2" aria-hidden="true">/</span><Link className="underline underline-offset-4" href="/admin/projects/deleted">Deleted projects</Link><span className="mx-2" aria-hidden="true">/</span>{project.publicId}</nav>
      <header><p className="font-mono text-xs text-muted-foreground">{project.publicId}</p><h1 className="mt-1 break-words text-2xl font-bold tracking-tight">{project.title}</h1><p className="mt-2 text-sm text-muted-foreground">Deleted project tombstone · no normal editing, review, approval or publication authority is granted here.</p></header>
      <section className="rounded-xl border border-warning/40 bg-warning/10 p-5" aria-labelledby="recovery-heading"><h2 id="recovery-heading" className="text-lg font-semibold">Recovery evidence</h2><p className="mt-1 text-sm text-foreground-subtle">{recovery.reason}</p><p className="mt-2 text-xs text-muted-foreground">Decision: {recovery.code}</p>{project.deletedAt && project.updatedAt && <div className="mt-4 max-w-sm"><DeletedProjectRecoveryAction publicId={project.publicId} expectedUpdatedAt={project.updatedAt} expectedDeletedAt={project.deletedAt} recoveryCode={recovery.code} /></div>}</section>
      <section className="grid gap-6 lg:grid-cols-2"><div className="rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">Retained project record</h2><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Status</dt><dd>{project.status}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Deleted at</dt><dd>{project.deletedAt ?? 'Not recorded'}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Program</dt><dd>{project.program ?? 'Not recorded'}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Discipline</dt><dd>{project.discipline ?? 'Not recorded'}</dd></div></dl><p className="mt-5 whitespace-pre-wrap text-sm text-foreground-subtle">{project.summary ?? 'No summary retained.'}</p></div><div className="rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">Retained media</h2><p className="mt-1 text-sm text-muted-foreground">Physical objects are retained. Recovery may clear only the four public mapping fields.</p><ul className="mt-4 divide-y divide-border text-sm">{detail.media.length === 0 ? <li className="py-3 text-muted-foreground">No media rows retained.</li> : detail.media.map((media) => <li key={String(media.id)} className="py-3"><p className="font-medium">{String(media.fileName ?? 'Unnamed asset')}</p><p className="text-xs text-muted-foreground">{String(media.assetType ?? 'asset')} · {media.isPublicApproved ? 'public mapping retained' : 'private mapping'}</p></li>)}</ul></div></section>
      <section className="rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">Retained history</h2><div className="mt-4 grid gap-6 lg:grid-cols-3"><HistoryList title="Audit records" rows={detail.approvalHistory} label="action" /><HistoryList title="Participant previews" rows={detail.participantPreviews} label="status" /><HistoryList title="Feed operations" rows={detail.feedHistory} label="kind" /></div></section>
    </div>
  );
}

function HistoryList({ title, rows, label }: { title: string; rows: Array<Record<string, unknown>>; label: string }) {
  return <div><h3 className="text-sm font-semibold">{title} ({rows.length})</h3><ul className="mt-2 max-h-72 overflow-y-auto divide-y divide-border rounded-lg border border-border text-xs">{rows.length === 0 ? <li className="p-3 text-muted-foreground">None retained.</li> : rows.map((row, index) => <li key={String(row.id ?? index)} className="p-3"><span className="font-medium">{String(row[label] ?? 'record')}</span>{typeof row.createdAt === 'string' && <time className="mt-1 block text-muted-foreground">{row.createdAt}</time>}</li>)}</ul></div>;
}
