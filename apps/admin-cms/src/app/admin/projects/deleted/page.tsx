import Link from 'next/link';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { ErrorState } from '../../../../components/ui/error-state';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { SupabaseDeletedProjectMaintenanceGateway } from '../../../../recovery/SupabaseDeletedProjectMaintenanceGateway';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function DeletedProjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await requireAdmin();
  if (!hasPermission(admin.permissions, 'projects.delete') || !admin.roles.includes('admin')) {
    return <ErrorState title="Access denied" description="Your account cannot inspect deleted project records." headingLevel="h1" />;
  }
  const raw = await searchParams;
  const single = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const page = /^\d{1,6}$/u.test(single(raw.page) ?? '') ? Number(single(raw.page)) : 1;
  const pageSize = single(raw.pageSize) === '50' ? 50 : 20;
  const search = (single(raw.search) ?? '').trim().slice(0, 100);
  let result;
  try {
    result = await new SupabaseDeletedProjectMaintenanceGateway(createSupabaseAdminClient()).list({ adminId: admin.adminUserId, page, pageSize: pageSize as 20 | 50, ...(search ? { search } : {}) });
  } catch {
    return <ErrorState title="Deleted projects unavailable" description="The retained project tombstones could not be loaded. Try again shortly." headingLevel="h1" />;
  }
  const href = (nextPage: number) => `/admin/projects/deleted?page=${nextPage}&pageSize=${pageSize}${search ? `&search=${encodeURIComponent(search)}` : ''}`;
  return (
    <div className="flex w-full flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground"><Link className="underline underline-offset-4" href="/admin">Projects</Link><span className="mx-2" aria-hidden="true">/</span>Deleted projects</nav>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="text-2xl font-bold tracking-tight text-foreground">Deleted projects</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Read-only tombstones retain media, participant evidence, publication history and audit history. Recovery is available only when exact evidence supports it.</p></div>
        <form className="flex gap-2" method="get"><Input name="search" defaultValue={search} aria-label="Search deleted projects" placeholder="Search ID or title" maxLength={100} /><input type="hidden" name="pageSize" value={pageSize} /><Button type="submit" variant="outline">Search</Button></form>
      </header>
      {result.total === 0 ? <p role="status" className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No deleted project tombstones match this search.</p> : (
        <>
          <p className="text-sm font-medium text-foreground">{result.total.toLocaleString()} retained tombstone{result.total === 1 ? '' : 's'}</p>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[720px] text-left text-sm"><caption className="sr-only">Deleted project tombstones</caption><thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-3">Project</th><th className="px-4 py-3">Deleted</th><th className="px-4 py-3">Recovery evidence</th><th className="px-4 py-3">Action</th></tr></thead><tbody className="divide-y divide-border">
              {result.items.map((item) => <tr key={item.publicId}><th scope="row" className="px-4 py-4 font-medium"><Link className="underline underline-offset-4" href={`/admin/projects/deleted/${encodeURIComponent(item.publicId)}`}>{item.title}</Link><span className="mt-1 block font-mono text-xs font-normal text-muted-foreground">{item.publicId}</span></th><td className="px-4 py-4 text-muted-foreground">{item.deletedAt ? new Date(item.deletedAt).toLocaleString() : 'State ambiguous'}</td><td className="max-w-sm px-4 py-4"><span className="font-medium">{item.recovery.code}</span><span className="mt-1 block text-xs text-muted-foreground">{item.recovery.reason}</span></td><td className="px-4 py-4"><Button asChild variant="outline" size="sm"><Link href={`/admin/projects/deleted/${encodeURIComponent(item.publicId)}`}>Inspect tombstone</Link></Button></td></tr>)}
            </tbody></table>
          </div>
          <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Page {result.page} of {result.pageCount}</p><div className="flex gap-2">{result.page > 1 ? <Button asChild variant="outline"><Link href={href(result.page - 1)}>Previous</Link></Button> : <Button type="button" variant="outline" disabled>Previous</Button>}{result.page < result.pageCount ? <Button asChild variant="outline"><Link href={href(result.page + 1)}>Next</Link></Button> : <Button type="button" variant="outline" disabled>Next</Button>}</div></div>
        </>
      )}
    </div>
  );
}
