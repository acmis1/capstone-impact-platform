'use client';

import * as React from 'react';
import { CheckCircle2, ClipboardCheck, LoaderCircle, XCircle } from 'lucide-react';
import type {
  BulkAssistiveExecutionResponse,
  BulkAssistivePreflightResponse,
} from '../../assistive-validation';
import type { ProjectIndexRow } from './projectDashboardHelpers';
import { bulkAssistiveDispositionLabel, bulkAssistiveOutcomeLabel, bulkAssistiveStatusLabel } from './bulkAssistivePresentation';
import { Button } from '../ui/button';

interface BulkAssistiveExecutionPanelProps {
  selectedProjects: ProjectIndexRow[];
  canRunAssistive: boolean;
  onBusyChange?: (busy: boolean) => void;
  sharedBusy?: boolean;
}

export function BulkAssistiveExecutionPanel({
  selectedProjects,
  canRunAssistive,
  onBusyChange,
  sharedBusy = false,
}: BulkAssistiveExecutionPanelProps) {
  const [preflight, setPreflight] = React.useState<BulkAssistivePreflightResponse | null>(null);
  const [execution, setExecution] = React.useState<BulkAssistiveExecutionResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const resultRef = React.useRef<HTMLDivElement>(null);
  const selectionKey = selectedProjects.map((project) => project.publicId || '').join('|');

  React.useEffect(() => {
    if (inFlight.current) return;
    setPreflight(null);
    setExecution(null);
    setError(null);
  }, [selectionKey]);

  React.useEffect(() => {
    if (execution) resultRef.current?.focus();
  }, [execution]);

  const requestError = (status: number, fallback: string) =>
    status === 403 ? 'You do not have permission to enqueue assistive checks.' : fallback;

  const runPreflight = async () => {
    if (inFlight.current || sharedBusy || selectedProjects.length === 0 || !canRunAssistive) return;
    inFlight.current = true;
    setLoading(true);
    onBusyChange?.(true);
    setError(null);
    setExecution(null);
    try {
      const response = await fetch('/api/projects/bulk-assistive/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicIds: selectedProjects.map((project) => project.publicId).filter(Boolean) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.items)) {
        throw new Error(requestError(response.status, 'The selected projects could not be checked. Try again.'));
      }
      setPreflight(data as BulkAssistivePreflightResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The selected projects could not be checked. Try again.');
      setPreflight(null);
    } finally {
      inFlight.current = false;
      setLoading(false);
      onBusyChange?.(false);
    }
  };

  const execute = async () => {
    if (inFlight.current || sharedBusy || !preflight) return;
    inFlight.current = true;
    setLoading(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const expectedInputHashes = Object.fromEntries(
        preflight.items.map((item) => [item.publicId, item.inputHash]),
      );
      const response = await fetch('/api/projects/bulk-assistive/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicIds: preflight.items.map((item) => item.publicId),
          expectedInputHashes,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.items)) {
        throw new Error(requestError(response.status, 'The assistive jobs could not be enqueued. Check the project list before trying again.'));
      }
      setExecution(data as BulkAssistiveExecutionResponse);
      setPreflight(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The assistive jobs could not be enqueued. Check the project list before trying again.');
    } finally {
      inFlight.current = false;
      setLoading(false);
      onBusyChange?.(false);
    }
  };

  if (selectedProjects.length === 0) return null;

  return (
    <section
      aria-labelledby="bulk-assistive-heading"
      aria-busy={loading}
      className="flex flex-col gap-3 rounded-lg border border-border-structural bg-card p-4 shadow-xs"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="bulk-assistive-heading" className="text-base font-semibold text-foreground">
            Assistive checks for selected projects
          </h2>
          <p className="text-sm text-muted-foreground">
            {selectedProjects.length} project{selectedProjects.length === 1 ? '' : 's'} selected. This queues bounded assistive jobs only; it does not change metadata, findings, review, publication, or archive state.
          </p>
        </div>
        <ClipboardCheck className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>

      <p className="text-xs text-muted-foreground">
        Up to 50 projects are processed per action. For a larger cohort, finish this page or chunk, clear the selection, and continue on the next page. The existing worker and dispatcher drain the queue.
      </p>

      {!canRunAssistive ? (
        <p role="alert" className="text-sm text-destructive">Your role cannot enqueue assistive checks.</p>
      ) : (
        <div className="flex flex-wrap gap-2" aria-label="Bulk assistive actions">
          <Button type="button" variant="outline" disabled={loading || sharedBusy} onClick={runPreflight}>
            {loading && !preflight ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            Check eligibility
          </Button>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading && <p role="status" className="text-sm text-muted-foreground">Checking or enqueuing selected assistive jobs…</p>}

      {preflight && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <p className="text-sm text-foreground">
            Checked {preflight.summary.total} project{preflight.summary.total === 1 ? '' : 's'}:{' '}
            <strong>{preflight.summary.eligible}</strong> ready,{' '}
            <strong>{preflight.summary.alreadyActiveOrCurrent}</strong> already active/current,{' '}
            <strong>{preflight.summary.blocked}</strong> blocked,{' '}
            <strong>{preflight.summary.invalidStale}</strong> invalid or stale.
          </p>
          <p className="text-sm text-foreground">
            Confirming queues the ready projects for assistive processing. A queued result remains evidence for staff review; it never accepts a finding or changes project authority.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={loading || sharedBusy || preflight.summary.eligible === 0} onClick={execute}>
              {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              Confirm and enqueue ready projects
            </Button>
            <Button type="button" variant="ghost" disabled={loading || sharedBusy} onClick={() => setPreflight(null)}>
              Cancel
            </Button>
          </div>
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm" aria-label="Assistive preflight details">
            {preflight.items.map((item) => (
              <li key={item.publicId} className="flex flex-col gap-1 border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="font-medium text-foreground">{item.title} <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span></span>
                <span className="text-muted-foreground">Status: {bulkAssistiveStatusLabel(item.status)} — {bulkAssistiveDispositionLabel(item.disposition)}</span>
                {item.reasons.map((itemReason, index) => <span key={`${item.publicId}-${itemReason.code}-${index}`} className="text-destructive">{itemReason.message}</span>)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {execution && (
        <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-3 border-t border-border pt-3 focus-visible:outline-none" role="status">
          <p className="text-sm font-medium text-foreground">
            Finished: {execution.summary.enqueued} enqueued, {execution.summary.alreadyActiveOrCurrent} already active/current,{' '}
            {execution.summary.blocked} blocked, {execution.summary.invalidStale} invalid/stale, {execution.summary.failed} failed.
          </p>
          <ul className="flex flex-col gap-2 text-sm" aria-label="Assistive enqueue results">
            {execution.items.map((item) => (
              <li key={item.publicId} className="flex flex-wrap items-center gap-2">
                {item.outcome === 'ENQUEUED' ? <CheckCircle2 className="size-4 text-success" aria-hidden="true" /> : <XCircle className="size-4 text-muted-foreground" aria-hidden="true" />}
                <span className="font-mono text-xs text-muted-foreground">{item.publicId}</span>
                <span className="text-foreground">{bulkAssistiveOutcomeLabel(item.outcome)}</span>
                {item.reasons[0] && <span className="text-muted-foreground">{item.reasons[0].message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
