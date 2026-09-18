import Link from 'next/link';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { staffDirectoryHref, type StaffDirectoryQuery } from '../../staff/staffDirectoryQuery';

export function StaffDirectoryFilters({ query, matching, pages }: { query: StaffDirectoryQuery; matching: number; pages: number }) {
  return <section aria-label="Staff directory filters" className="space-y-3">
    <form action="/admin/staff" method="get" className="flex flex-wrap items-end gap-3">
      <div className="space-y-1"><Label htmlFor="staff-search">Name or email</Label><Input id="staff-search" name="q" type="search" defaultValue={query.q} maxLength={100} /></div>
      <div className="space-y-1"><Label htmlFor="staff-status">Account status</Label><select id="staff-status" name="status" defaultValue={query.status} className="h-10 rounded-md border border-input bg-background px-3"><option value="">All statuses</option><option value="active">Active</option><option value="pending_activation">Awaiting setup</option><option value="deactivated">Deactivated</option></select></div>
      <Button type="submit">Search staff</Button><Button asChild variant="outline"><Link href="/admin/staff">Clear filters</Link></Button>
    </form>
    <nav aria-label="Staff directory pages" className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">{matching} matching accounts · Page {query.page} of {pages}. Summary counts and invitation issues remain unfiltered.</p>
      {query.page > 1 && <Button asChild variant="outline"><Link href={staffDirectoryHref(query, query.page - 1)}>Previous staff page</Link></Button>}
      {query.page < pages && <Button asChild variant="outline"><Link href={staffDirectoryHref(query, query.page + 1)}>Next staff page</Link></Button>}
      {query.page > pages && <Button asChild variant="outline"><Link href={staffDirectoryHref(query, 1)}>First staff page</Link></Button>}
    </nav>
  </section>;
}
