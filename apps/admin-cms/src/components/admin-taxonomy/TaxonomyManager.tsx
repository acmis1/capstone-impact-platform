'use client';

import React from 'react';
import { z } from 'zod';
import { postgresUuidSchema } from '../../projects/projectMetadata';
import { parseTaxonomyLifecycleResponse } from '../../taxonomy/taxonomyLifecycleResponse';
import { useRouter } from 'next/navigation';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  TAXONOMY_KINDS,
  TAXONOMY_LABELS,
  type TaxonomyEntry,
  type TaxonomyKind,
} from '../../taxonomy/taxonomy';
import {
  addTaxonomyEntry,
  updateTaxonomyNotice,
  type TaxonomyNotice,
} from './taxonomyManagerState';

type CatalogueState = Record<TaxonomyKind, TaxonomyEntry[]>;
type NoticeState = Record<TaxonomyKind, TaxonomyNotice>;

const emptyNotices: NoticeState = {
  program: null,
  discipline: null,
  industryCategory: null,
};

const SINGULAR_LABELS: Record<TaxonomyKind, string> = {
  program: 'program',
  discipline: 'discipline',
  industryCategory: 'industry category',
};

function actionError(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }
  if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  return 'The catalogue change could not be completed. Try again.';
}

export interface TaxonomyManagerProps {
  initialCatalogues: CatalogueState;
}

/**
 * Small add-first manager for the three authoritative lookup catalogues. Catalogue text is rendered
 * as ordinary React text, so a name containing markup is never interpreted as markup by the UI.
 */
export function TaxonomyManager({ initialCatalogues }: TaxonomyManagerProps) {
  const router = useRouter();
  const [catalogues, setCatalogues] = React.useState<CatalogueState>(initialCatalogues);
  const [drafts, setDrafts] = React.useState<Record<TaxonomyKind, string>>({
    program: '', discipline: '', industryCategory: '',
  });
  const [notices, setNotices] = React.useState<NoticeState>(emptyNotices);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [pending, setPending] = React.useState<{ kind: TaxonomyKind; entry: TaxonomyEntry; action: 'retire' | 'reactivate' | 'rename' } | null>(null);
  const [rename, setRename] = React.useState('');
  const [unknownWrite, setUnknownWrite] = React.useState(false);
  const inFlight = React.useRef(false);
  const [observedCatalogues, setObservedCatalogues] = React.useState(initialCatalogues);
  const [pages, setPages] = React.useState<Record<TaxonomyKind, number>>({ program: 1, discipline: 1, industryCategory: 1 });
  const [visibility, setVisibility] = React.useState('all');
  if (observedCatalogues !== initialCatalogues) { setObservedCatalogues(initialCatalogues); setCatalogues(initialCatalogues); }
  const markUnknown = (kind: TaxonomyKind) => {
    setUnknownWrite(true);
    setNotice(kind, { variant: 'error', message: 'The write outcome is unknown. Reload the catalogue before trying again.' });
  };

  const setNotice = (kind: TaxonomyKind, notice: TaxonomyNotice) => {
    setNotices((current) => updateTaxonomyNotice(current, kind, notice));
  };

  const create = async (event: React.FormEvent<HTMLFormElement>, kind: TaxonomyKind) => {
    event.preventDefault();
    if (busy || unknownWrite || inFlight.current) return;
    inFlight.current = true;
    setBusy(`${kind}:create`);
    setNotice(kind, null);
    try {
      const response = await fetch(`/api/taxonomy/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: drafts[kind] }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; entry?: { id: string; name: string } } | null;
      if (response.status >= 500 || (!response.ok && payload?.success === true) || response.ok && (payload?.success !== true || !payload.entry)) { markUnknown(kind); return; }
      if (!response.ok || payload?.success !== true || !payload.entry) {
        setNotice(kind, { variant: 'error', message: actionError(payload) });
        return;
      }
      const entry = z.object({ id: postgresUuidSchema, name: z.string().min(1).max(120) }).strict().parse(payload.entry);
      if (entry.name !== drafts[kind].trim()) throw new Error('Unexpected created catalogue value');
      setCatalogues(current => ({ ...current, [kind]: addTaxonomyEntry(current[kind], entry) }));
      setDrafts((current) => ({ ...current, [kind]: '' }));
      setNotice(kind, { variant: 'success', message: `${SINGULAR_LABELS[kind][0].toUpperCase()}${SINGULAR_LABELS[kind].slice(1)} added.` });
      router.refresh();
    } catch {
      markUnknown(kind);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const lifecycle = async () => {
    if (!pending || busy || unknownWrite || inFlight.current) return;
    inFlight.current = true;
    const name = pending.action === 'rename' ? rename : undefined;
    setBusy(`${pending.kind}:${pending.entry.id}:${pending.action}`);
    setNotice(pending.kind, null);
    try {
      const response = await fetch(`/api/taxonomy/${pending.kind}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: pending.action,
          id: pending.entry.id,
          expectedLifecycleVersion: pending.entry.lifecycleVersion ?? 1,
          ...(name === undefined ? {} : { name }),
        }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; code?: string; entry?: { id: string; name: string } } | null;
      if (response.status >= 500 || (!response.ok && payload?.success === true) || response.ok && (payload?.success !== true || !payload.entry)) { markUnknown(pending.kind); return; }
      if (!response.ok || payload?.success !== true || !payload.entry) {
        setNotice(pending.kind, { variant: 'error', message: actionError(payload) });
        return;
      }
      const verified = parseTaxonomyLifecycleResponse({ ...payload.entry, resultCode: payload.code }, { taxonomyId: pending.entry.id, action: pending.action, expectedLifecycleVersion: pending.entry.lifecycleVersion ?? 1, name });
      if (!('id' in verified)) throw new Error('Contradictory catalogue lifecycle result');
      const actionCode = verified.resultCode;
      setCatalogues((current) => ({
        ...current,
        [pending.kind]: current[pending.kind].map((entry) => entry.id !== pending.entry.id ? entry : {
          ...entry,
          name: verified.name,
          retiredAt: verified.retiredAt,
          lifecycleVersion: verified.lifecycleVersion,
        }),
      }));
      setNotice(pending.kind, { variant: 'success', message: actionCode === 'RENAMED' ? 'Catalogue value renamed.' : actionCode === 'RETIRED' ? 'Catalogue value retired from future choices.' : actionCode === 'REACTIVATED' ? 'Catalogue value reactivated.' : 'No catalogue change was needed.' });
      setPending(null);
      router.refresh();
    } catch {
      markUnknown(pending.kind);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="flex flex-wrap items-center gap-3 xl:col-span-3">
        <Label htmlFor="catalogue-visibility">Catalogue status</Label>
        <select id="catalogue-visibility" value={visibility} onChange={event => { setVisibility(event.target.value); setPages({ program: 1, discipline: 1, industryCategory: 1 }); }} className="min-h-10 rounded-md border border-input bg-background px-3"><option value="all">All values</option><option value="active">Active only</option><option value="retired">Retired only</option></select>
        <Button variant="outline" disabled={busy !== null} onClick={() => window.location.reload()}>Reload catalogue</Button>
        {unknownWrite && <p role="status" className="text-sm text-warning-strong">Reload required before another write.</p>}
      </div>
      {TAXONOMY_KINDS.map((kind) => {
        const entries = catalogues[kind];
        const filtered = entries.filter(entry => entry.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (visibility === 'all' || (visibility === 'retired' ? Boolean(entry.retiredAt) : !entry.retiredAt)));
        const pageCount = Math.max(1, Math.ceil(filtered.length / 20));
        const page = Math.min(pageCount, pages[kind]);
        const visibleEntries = filtered.slice((page - 1) * 20, page * 20);
        const isCreating = busy === `${kind}:create`;
        const notice = notices[kind];
        return (
          <Card key={kind} className="flex min-w-0 flex-col border-border-structural">
            <CardHeader>
              <CardTitle>{TAXONOMY_LABELS[kind]}</CardTitle>
              <CardDescription>
                {entries.filter(entry => !entry.retiredAt).length} active values; {entries.filter(entry => entry.retiredAt).length} retired values retained for history.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5">
              {notice && <Alert variant={notice.variant === 'success' ? 'success' : 'destructive'} title={notice.variant === 'success' ? 'Updated' : 'Could not update'} description={notice.message} />}
              <form onSubmit={(event) => create(event, kind)} className="flex flex-col gap-3" aria-busy={isCreating}>
                <Label htmlFor={`${kind}-name`}>Add {SINGULAR_LABELS[kind]}</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id={`${kind}-name`}
                    value={drafts[kind]}
                    onChange={(event) => setDrafts((current) => ({ ...current, [kind]: event.target.value }))}
                    maxLength={120}
                    required
                    disabled={busy !== null || unknownWrite}
                    autoComplete="off"
                  />
                  <Button type="submit" disabled={busy !== null || unknownWrite} className="min-h-11 shrink-0">
                    {isCreating ? 'Adding…' : 'Add value'}
                  </Button>
                </div>
              </form>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${kind}-search`} className="text-xs">Filter values</Label>
                <Input id={`${kind}-search`} value={search} onChange={(event) => { setSearch(event.target.value); setPages({ program: 1, discipline: 1, industryCategory: 1 }); }} placeholder="Search all catalogues" />
              </div>
              <ul aria-label={`${TAXONOMY_LABELS[kind]} catalogue`} className="divide-y divide-border/70 rounded-lg border border-border/70">
                {visibleEntries.map((entry) => {
                  return (
                    <li key={entry.id} className="flex min-w-0 items-center justify-between gap-3 px-3 py-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-foreground">{entry.name}{entry.retiredAt && <span className="ml-2 text-xs font-normal text-muted-foreground">Retired</span>}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {entry.usageCount === 0 ? 'Not currently used' : `Used by ${entry.usageCount} ${entry.usageCount === 1 ? 'project' : 'projects'}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-2">
                        <Button type="button" variant="outline" className="min-h-9" disabled={busy !== null || unknownWrite} onClick={() => { setPending({ kind, entry, action: entry.retiredAt ? 'reactivate' : 'retire' }); setRename(entry.name); }}>
                          {entry.retiredAt ? 'Reactivate' : 'Retire'}
                        </Button>
                        <Button type="button" variant="ghost" className="min-h-9" disabled={busy !== null || unknownWrite || entry.usageCount > 0} onClick={() => { setPending({ kind, entry, action: 'rename' }); setRename(entry.name); }}>
                          Rename
                        </Button>
                      </div>
                    </li>
                  );
                })}
                {visibleEntries.length === 0 && <li className="px-3 py-4 text-sm text-muted-foreground">No matching catalogue values.</li>}
              </ul>
              <nav aria-label={TAXONOMY_LABELS[kind] + ' catalogue pages'} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <Button variant="outline" disabled={page <= 1} onClick={() => setPages(current => ({ ...current, [kind]: page - 1 }))}>Previous</Button>
                <span>{filtered.length} matching values · Page {page} of {pageCount}</span>
                <Button variant="outline" disabled={page >= pageCount} onClick={() => setPages(current => ({ ...current, [kind]: page + 1 }))}>Next</Button>
              </nav>
            </CardContent>
          </Card>
        );
      })}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !busy && !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.action === 'rename' ? 'Rename catalogue value?' : pending?.action === 'retire' ? 'Retire catalogue value?' : 'Reactivate catalogue value?'}</AlertDialogTitle>
            <AlertDialogDescription>
              Retired values cannot be newly assigned. Existing associations and historical labels remain readable. No physical category deletion is available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending && <p className="text-sm font-semibold">{pending.entry.name} · revision {pending.entry.lifecycleVersion ?? 1}</p>}
          {pending && notices[pending.kind] && <Alert variant="destructive" title="Could not update" description={notices[pending.kind]!.message} />}
          {pending?.action === 'rename' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="taxonomy-rename">New name</Label>
              <Input id="taxonomy-rename" value={rename} onChange={(event) => setRename(event.target.value)} maxLength={120} autoFocus />
              <p className="text-xs text-muted-foreground">Rename is accepted only when the database has zero references.</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy !== null || unknownWrite || (pending?.action === 'rename' && rename.trim() === '')} onClick={(event) => { event.preventDefault(); void lifecycle(); }}>
              {pending?.action === 'rename' ? 'Rename value' : pending?.action === 'retire' ? 'Retire value' : 'Reactivate value'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
