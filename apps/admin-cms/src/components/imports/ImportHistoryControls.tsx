import Link from 'next/link';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { IMPORT_HISTORY_PAGE_SIZE, IMPORT_HISTORY_STATUSES, importHistoryHref, type ImportHistoryQuery } from '../../import/importHistoryQuery';

export function ImportHistoryFilters({ query }: { query: ImportHistoryQuery }) {
  return (
    <form action="/admin/imports" method="get" className="grid items-end gap-4 rounded-xl border border-border p-4 sm:grid-cols-4" aria-label="Filter import history">
      <div className="space-y-2"><Label htmlFor="import-history-search">Batch name</Label><Input id="import-history-search" name="q" type="search" maxLength={100} defaultValue={query.q} /></div>
      <div className="space-y-2"><Label htmlFor="import-history-year">Import year</Label><Input id="import-history-year" name="year" inputMode="numeric" pattern="(19|20|21)[0-9]{2}" maxLength={4} defaultValue={query.year} aria-describedby="import-history-year-help" /><p id="import-history-year-help" className="text-xs text-muted-foreground">Year the batch was imported, not the projects’ academic year.</p></div>
      <div className="space-y-2"><Label htmlFor="import-history-status">Batch status</Label><select id="import-history-status" name="status" defaultValue={query.status} className="h-10 w-full rounded-md border border-input bg-background px-3"><option value="">All statuses</option>{IMPORT_HISTORY_STATUSES.map(status => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></div>
      <div className="flex flex-wrap gap-2"><Button type="submit">Apply filters</Button><Button asChild variant="outline"><Link href="/admin/imports">Clear filters</Link></Button></div>
    </form>
  );
}

export function ImportHistoryPagination({ query, total }: { query: ImportHistoryQuery; total: number }) {
  const pages = Math.max(1, Math.ceil(total / IMPORT_HISTORY_PAGE_SIZE));
  return (
    <nav aria-label="Import history pages" className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">{total} matching batches · Page {query.page} of {pages}</p>
      {query.page > 1 && <Button asChild variant="outline"><Link href={importHistoryHref(query, query.page - 1)}>Newer batches</Link></Button>}
      {query.page < pages && <Button asChild variant="outline"><Link href={importHistoryHref(query, query.page + 1)}>Older batches</Link></Button>}
      {query.page > pages && <Button asChild variant="outline"><Link href={importHistoryHref(query, 1)}>First page</Link></Button>}
    </nav>
  );
}
