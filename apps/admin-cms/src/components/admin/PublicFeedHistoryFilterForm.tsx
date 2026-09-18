import Link from 'next/link';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import type { PublicFeedHistoryFilters } from '../../projects/publicFeedHistoryQuery';

export function PublicFeedHistoryFilterForm({ filters }: { filters: PublicFeedHistoryFilters }) {
  return (
    <form action="/admin/public-feed" method="get" aria-label="Filter publishing activity" className="grid items-end gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 xl:grid-cols-5">
      <div className="space-y-1"><Label htmlFor="history-project">Exact project ID</Label><Input id="history-project" name="project" maxLength={100} defaultValue={filters.project} pattern="[A-Za-z0-9_-]*" /></div>
      <div className="space-y-1"><Label htmlFor="history-operation">Activity</Label><select id="history-operation" name="operation" defaultValue={filters.operation} className="h-10 w-full rounded-md border border-input bg-background px-2"><option value="">All activities</option><option value="publication">Publication</option><option value="removal">Removal</option><option value="rollback">Feed rollback</option><option value="baseline">Initial setup</option></select></div>
      <div className="space-y-1"><Label htmlFor="history-from">From date (UTC)</Label><Input id="history-from" name="from" type="date" defaultValue={filters.from} /></div>
      <div className="space-y-1"><Label htmlFor="history-to">Through date (UTC)</Label><Input id="history-to" name="to" type="date" defaultValue={filters.to} /></div>
      <div className="flex flex-wrap gap-2"><Button type="submit">Filter activity</Button><Button asChild variant="outline"><Link href="/admin/public-feed">Clear filters</Link></Button></div>
    </form>
  );
}
