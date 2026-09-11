'use client';

import React from 'react';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  TAXONOMY_KINDS,
  TAXONOMY_LABELS,
  type TaxonomyEntry,
  type TaxonomyKind,
} from '../../taxonomy/taxonomy';
import {
  addTaxonomyEntry,
  removeTaxonomyEntryFromState,
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

  const setNotice = (kind: TaxonomyKind, notice: TaxonomyNotice) => {
    setNotices((current) => updateTaxonomyNotice(current, kind, notice));
  };

  const create = async (event: React.FormEvent<HTMLFormElement>, kind: TaxonomyKind) => {
    event.preventDefault();
    if (busy) return;
    setBusy(`${kind}:create`);
    setNotice(kind, null);
    try {
      const response = await fetch(`/api/taxonomy/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: drafts[kind] }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; entry?: { id: string; name: string } } | null;
      if (!response.ok || !payload?.success || !payload.entry) {
        setNotice(kind, { variant: 'error', message: actionError(payload) });
        return;
      }
      setCatalogues((current) => ({ ...current, [kind]: addTaxonomyEntry(current[kind], payload.entry!) }));
      setDrafts((current) => ({ ...current, [kind]: '' }));
      setNotice(kind, { variant: 'success', message: `${SINGULAR_LABELS[kind][0].toUpperCase()}${SINGULAR_LABELS[kind].slice(1)} added.` });
      router.refresh();
    } catch {
      setNotice(kind, { variant: 'error', message: 'The catalogue change could not be completed. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kind: TaxonomyKind, entry: TaxonomyEntry) => {
    if (busy) return;
    setBusy(`${kind}:${entry.id}`);
    setNotice(kind, null);
    try {
      const response = await fetch(`/api/taxonomy/${kind}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean } | null;
      if (!response.ok || !payload?.success) {
        setNotice(kind, { variant: 'error', message: actionError(payload) });
        return;
      }
      setCatalogues((current) => ({ ...current, [kind]: removeTaxonomyEntryFromState(current[kind], entry.id) }));
      setNotice(kind, { variant: 'success', message: `${entry.name} removed.` });
      router.refresh();
    } catch {
      setNotice(kind, { variant: 'error', message: 'The catalogue change could not be completed. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      {TAXONOMY_KINDS.map((kind) => {
        const entries = catalogues[kind];
        const isCreating = busy === `${kind}:create`;
        const notice = notices[kind];
        return (
          <Card key={kind} className="flex min-w-0 flex-col border-border-structural">
            <CardHeader>
              <CardTitle>{TAXONOMY_LABELS[kind]}</CardTitle>
              <CardDescription>
                {entries.length} {entries.length === 1 ? 'value' : 'values'} available to current project workflows.
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
                    disabled={busy !== null}
                    autoComplete="off"
                  />
                  <Button type="submit" disabled={busy !== null} className="min-h-11 shrink-0">
                    {isCreating ? 'Adding…' : 'Add value'}
                  </Button>
                </div>
              </form>
              <ul aria-label={`${TAXONOMY_LABELS[kind]} catalogue`} className="divide-y divide-border/70 rounded-lg border border-border/70">
                {entries.map((entry) => {
                  const entryBusy = busy === `${kind}:${entry.id}`;
                  const removable = entry.usageCount === 0;
                  return (
                    <li key={entry.id} className="flex min-w-0 items-center justify-between gap-3 px-3 py-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-foreground">{entry.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {entry.usageCount === 0 ? 'Unused — safe to remove' : `Used by ${entry.usageCount} ${entry.usageCount === 1 ? 'project' : 'projects'}`}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 shrink-0 text-destructive hover:text-destructive"
                        disabled={!removable || busy !== null}
                        aria-label={`Remove ${entry.name}`}
                        title={removable ? `Remove ${entry.name}` : 'Used values cannot be removed'}
                        onClick={() => remove(kind, entry)}
                      >
                        <Trash2 aria-hidden="true" />
                        <span className="sr-only">{entryBusy ? 'Removing' : 'Remove'}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
