'use client';

import * as React from 'react';
import { LoaderCircle, ShieldAlert, Trash2 } from 'lucide-react';
import type { ProjectIndexRow } from './projectDashboardHelpers';
import { isSafeBulkPublicId } from '../../projects/bulkProjectReview';
import { SOFT_DELETE_MAX_SELECTION, type SoftDeletePreflightResponse } from '../../projects/projectSoftDelete';
import {
  parseBoundedSoftDeletePreflight,
  readBoundedSoftDeleteJson,
  runSoftDeleteBatch,
  SOFT_DELETE_OUTCOME_LABELS,
  type SoftDeleteBatchRunResult,
} from './softDeleteCoordinator';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';

interface BulkSoftDeletePanelProps {
  selectedProjects: ProjectIndexRow[];
  canDelete: boolean;
  sharedBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

type BusyChange = NonNullable<BulkSoftDeletePanelProps['onBusyChange']>;
const busyOwners = new WeakMap<BusyChange, symbol>();

function acquireBusyLease(onBusyChange: BusyChange | undefined): (() => void) | null {
  if (!onBusyChange) return null;
  const owner = Symbol('soft-delete-busy');
  busyOwners.set(onBusyChange, owner);
  onBusyChange(true);
  return () => {
    if (busyOwners.get(onBusyChange) !== owner) return;
    busyOwners.delete(onBusyChange);
    onBusyChange(false);
  };
}

function getBoundedSelectedPublicIds(selectedProjects: ProjectIndexRow[]): string[] | null {
  const publicIds = selectedProjects.map((project) => project.publicId);
  if (
    publicIds.length < 1
    || publicIds.length > SOFT_DELETE_MAX_SELECTION
    || !publicIds.every((publicId): publicId is string => isSafeBulkPublicId(publicId))
    || new Set(publicIds).size !== publicIds.length
  ) return null;
  return publicIds;
}

export function BulkSoftDeletePanel({
  selectedProjects,
  canDelete,
  sharedBusy = false,
  onBusyChange,
}: BulkSoftDeletePanelProps) {
  const [preflight, setPreflight] = React.useState<SoftDeletePreflightResponse | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [result, setResult] = React.useState<SoftDeleteBatchRunResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  const requestController = React.useRef<AbortController | null>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);
  const busyRelease = React.useRef<(() => void) | null>(null);

  const releaseBusy = () => {
    const release = busyRelease.current;
    busyRelease.current = null;
    release?.();
  };

  const claimBusy = () => {
    releaseBusy();
    busyRelease.current = acquireBusyLease(onBusyChange);
  };

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestController.current?.abort();
      releaseBusy();
    };
  }, []);

  React.useEffect(() => {
    if (result && !running) resultRef.current?.focus();
  }, [result, running]);

  if (!canDelete || selectedProjects.length === 0) return null;

  const runPreflight = async () => {
    if (inFlight.current || sharedBusy) return;
    const selectedPublicIds = getBoundedSelectedPublicIds(selectedProjects);
    if (!selectedPublicIds) {
      setError('The selected projects could not be checked. No deletion request was made.');
      setPreflight(null);
      setAcknowledged(false);
      setResult(null);
      return;
    }
    inFlight.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setChecking(true);
    setError(null);
    setResult(null);
    setPreflight(null);
    setAcknowledged(false);
    claimBusy();
    try {
      const response = await fetch('/api/projects/soft-delete/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicIds: selectedPublicIds }),
        signal: controller.signal,
      });
      const data = await readBoundedSoftDeleteJson(response).catch(() => null);
      if (!mounted.current || controller.signal.aborted) return;
      if (!response.ok) throw new Error('Preflight failed.');
      const parsed = parseBoundedSoftDeletePreflight(data, selectedPublicIds);
      if (!parsed) throw new Error('Preflight failed.');
      setPreflight(parsed);
    } catch {
      if (!mounted.current) return;
      setError('The selected projects could not be checked. No deletion request was made.');
      setPreflight(null);
      setAcknowledged(false);
    } finally {
      clearTimeout(timeout);
      inFlight.current = false;
      requestController.current = null;
      releaseBusy();
      if (mounted.current) setChecking(false);
    }
  };

  const execute = async () => {
    if (inFlight.current || sharedBusy || !preflight || preflight.summary.eligible === 0 || !acknowledged) return;
    inFlight.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    claimBusy();
    try {
      const finalResult = await runSoftDeleteBatch({
        preflightItems: preflight.items,
        signal: controller.signal,
        isActive: () => mounted.current,
        onUpdate: (next) => setResult(next),
      });
      if (mounted.current) setResult(finalResult);
    } catch {
      if (mounted.current) {
        setError('The batch result is unknown. Inspect project and audit state before any retry.');
      }
    } finally {
      inFlight.current = false;
      requestController.current = null;
      releaseBusy();
      if (mounted.current) setRunning(false);
    }
  };

  return (
    <section aria-labelledby="bulk-soft-delete-heading" aria-busy={checking || running} className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="bulk-soft-delete-heading" className="text-base font-semibold text-foreground">Delete selected projects</h2>
          <p className="text-sm text-muted-foreground">
            {selectedProjects.length} selected on this page. Eligibility is checked by the server before confirmation.
          </p>
        </div>
        <Trash2 className="size-5 text-destructive" aria-hidden="true" />
      </div>

      <p className="text-xs text-muted-foreground">
        Up to 50 projects are processed sequentially with no automatic retries. An unknown result stops the batch and leaves every later project Not attempted.
      </p>

      {!preflight && !result && (
        <Button type="button" variant="destructive" disabled={sharedBusy || checking} onClick={runPreflight} className="self-start">
          {checking ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          Review delete batch
        </Button>
      )}

      {error && <Alert variant="destructive" title="Batch delete unavailable" description={error} />}

      {preflight && !running && !result && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <Alert variant="warning" icon={ShieldAlert} title="Confirm governed soft delete">
            <p className="text-sm text-muted-foreground">
              {preflight.summary.eligible} of {preflight.summary.total} selected projects are currently eligible.
              Soft delete retains every project row, uploaded asset, participant record, publication/removal event,
              feed version, and audit record. Deleted projects cannot be edited, reviewed, published, or restored
              through the archive-restore workflow.
            </p>
          </Alert>
          <ul className="max-h-72 space-y-2 overflow-y-auto text-sm" aria-label="Soft delete eligibility results">
            {preflight.items.map((item) => (
              <li key={item.publicId} className="border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="font-medium text-foreground">{item.title}</span>{' '}
                <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span>
                <span className={item.disposition === 'eligible' ? 'block text-foreground' : 'block text-destructive'}>
                  {item.disposition === 'eligible' ? 'Eligible' : item.disposition === 'already_deleted' ? 'Already soft-deleted' : 'Ineligible'}: {item.reason}
                </span>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={sharedBusy}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 size-4"
            />
            <span>I understand this is a governed soft delete, retained history and assets remain, and only the eligible projects listed above will be attempted.</span>
          </label>
          {preflight.summary.eligible === 0 && (
            <p role="alert" className="text-sm text-destructive">No selected project is eligible. No delete request can be made.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" disabled={sharedBusy || !acknowledged || preflight.summary.eligible === 0} onClick={execute}>
              Confirm and soft-delete {preflight.summary.eligible} project{preflight.summary.eligible === 1 ? '' : 's'}
            </Button>
            <Button type="button" variant="ghost" disabled={sharedBusy} onClick={() => { setPreflight(null); setAcknowledged(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {running && (
        <div className="flex flex-wrap items-center gap-3" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          <span className="text-sm text-foreground">Soft-deleting one eligible project at a time. Keep this page open.</span>
          <Button type="button" variant="outline" onClick={() => requestController.current?.abort()}>Stop batch</Button>
          <span className="text-xs text-muted-foreground">The in-flight result becomes Unknown because the server may already have committed.</span>
        </div>
      )}

      {result && (
        <div ref={resultRef} tabIndex={-1} role="status" className="flex flex-col gap-3 border-t border-border pt-3 focus-visible:outline-none">
          <p className="text-sm font-medium text-foreground">
            Batch result: {result.items.filter((item) => item.outcome === 'DELETED').length} deleted,{' '}
            {result.items.filter((item) => item.outcome === 'ALREADY_DELETED').length} already deleted,{' '}
            {result.items.filter((item) => item.outcome === 'INELIGIBLE').length} ineligible,{' '}
            {result.items.filter((item) => item.outcome === 'STALE').length} stale,{' '}
            {result.items.filter((item) => item.outcome === 'DENIED').length} denied,{' '}
            {result.items.filter((item) => item.outcome === 'FAILED').length} failed,{' '}
            {result.items.filter((item) => item.outcome === 'UNKNOWN').length} unknown, and{' '}
            {result.items.filter((item) => item.outcome === 'NOT_ATTEMPTED').length} not attempted.
          </p>
          {result.stopped && <Alert variant="warning" title="Batch stopped" description={result.stopReason ?? 'Inspect state before any retry.'} />}
          <ul className="space-y-2 text-sm" aria-label="Soft delete batch results">
            {result.items.map((item) => (
              <li key={item.publicId} className="border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="font-medium text-foreground">{item.title}</span>{' '}
                <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span>
                <span className="block text-foreground">{SOFT_DELETE_OUTCOME_LABELS[item.outcome]}</span>
                <span className="block text-muted-foreground">{item.detail}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Refresh the project list and inspect audit state before explicitly selecting any later retry. This batch never resumes automatically.</p>
        </div>
      )}
    </section>
  );
}
