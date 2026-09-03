'use client';

import * as React from 'react';
import { CheckCircle2, ClipboardCheck, LoaderCircle, XCircle } from 'lucide-react';
import {
  BulkReviewAction,
  BulkReviewExecutionResponse,
  BulkReviewPreflightResponse,
} from '../../projects/bulkProjectReview';
import type { ProjectIndexRow } from './projectDashboardHelpers';
import { bulkDispositionLabel, bulkOutcomeLabel, bulkStatusLabel } from './bulkReviewPresentation';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';

interface BulkProjectReviewPanelProps {
  selectedProjects: ProjectIndexRow[];
  canSubmitBulk: boolean;
  canReviewBulk: boolean;
  onBusyChange?: (busy: boolean) => void;
}

function actionLabel(action: BulkReviewAction): string {
  if (action === 'submit_for_review') return 'Submit for review';
  if (action === 'request_changes') return 'Request changes';
  return 'Approve';
}

export function BulkProjectReviewPanel({
  selectedProjects,
  canSubmitBulk,
  canReviewBulk,
  onBusyChange,
}: BulkProjectReviewPanelProps) {
  const [preflight, setPreflight] = React.useState<BulkReviewPreflightResponse | null>(null);
  const [execution, setExecution] = React.useState<BulkReviewExecutionResponse | null>(null);
  const [activeAction, setActiveAction] = React.useState<BulkReviewAction | null>(null);
  const [comments, setComments] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const resultRef = React.useRef<HTMLDivElement>(null);
  const selectionKey = selectedProjects.map((project) => project.publicId || '').join('|');

  React.useEffect(() => {
    if (inFlight.current) return;
    setPreflight(null);
    setExecution(null);
    setActiveAction(null);
    setError(null);
  }, [selectionKey]);

  React.useEffect(() => {
    if (execution) resultRef.current?.focus();
  }, [execution]);

  const runPreflight = async (action: BulkReviewAction) => {
    if (inFlight.current || selectedProjects.length === 0) return;
    inFlight.current = true;
    setLoading(true);
    onBusyChange?.(true);
    setError(null);
    setExecution(null);
    setActiveAction(action);
    try {
      const response = await fetch('/api/projects/bulk-review/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, publicIds: selectedProjects.map((project) => project.publicId).filter(Boolean) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.items)) throw new Error('Preflight failed.');
      setPreflight(data as BulkReviewPreflightResponse);
    } catch {
      setError('The selected projects could not be checked. Try again.');
      setPreflight(null);
    } finally {
      inFlight.current = false;
      setLoading(false);
      onBusyChange?.(false);
    }
  };

  const execute = async () => {
    if (inFlight.current || !preflight || !activeAction) return;
    inFlight.current = true;
    setLoading(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const expectedUpdatedAt = Object.fromEntries(
        preflight.items.map((item) => [item.publicId, item.updatedAt]),
      );
      const response = await fetch('/api/projects/bulk-review/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: activeAction,
          publicIds: preflight.items.map((item) => item.publicId),
          expectedUpdatedAt,
          ...(activeAction === 'request_changes' ? { comments: comments.trim() } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.items)) throw new Error('Execution failed.');
      setExecution(data as BulkReviewExecutionResponse);
      setPreflight(null);
    } catch {
      setError('The action could not be completed for the selected projects. Check the project list before trying again.');
    } finally {
      inFlight.current = false;
      setLoading(false);
      onBusyChange?.(false);
    }
  };

  if (selectedProjects.length === 0) return null;

  return (
    <section
      aria-labelledby="bulk-review-heading"
      aria-busy={loading}
      className="flex flex-col gap-3 rounded-lg border border-border-structural bg-card p-4 shadow-xs"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="bulk-review-heading" className="text-base font-semibold text-foreground">
            Review selected projects
          </h2>
          <p className="text-sm text-muted-foreground">
            {selectedProjects.length} project{selectedProjects.length === 1 ? '' : 's'} selected. Every action is checked first, and you confirm before anything changes.
          </p>
        </div>
        <ClipboardCheck className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Bulk project actions">
        {canSubmitBulk && (
          <Button type="button" variant="outline" disabled={loading} onClick={() => runPreflight('submit_for_review')}>
            {loading && activeAction === 'submit_for_review' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {actionLabel('submit_for_review')}
          </Button>
        )}
        {canReviewBulk && (
          <>
            <Button type="button" variant="outline" disabled={loading} onClick={() => runPreflight('approve')}>
              {loading && activeAction === 'approve' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              Approve
            </Button>
            <Button type="button" variant="outline" disabled={loading} onClick={() => runPreflight('request_changes')}>
              {loading && activeAction === 'request_changes' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              Request changes
            </Button>
          </>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading && <p role="status" className="text-sm text-muted-foreground">Checking the selected projects…</p>}

      {preflight && activeAction && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <p className="text-sm text-foreground">
            Checked {preflight.summary.total} project{preflight.summary.total === 1 ? '' : 's'}:{' '}
            <strong>{preflight.summary.eligible}</strong> ready,{' '}
            <strong>{preflight.summary.blocked}</strong> blocked,{' '}
            <strong>{preflight.summary.alreadyComplete}</strong> already complete,{' '}
            <strong>{preflight.summary.invalidOrStale}</strong> needs refresh or cannot continue.
          </p>
          {activeAction === 'request_changes' && (
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground" htmlFor="bulk-review-comments">
              Shared review comment <span className="font-normal text-muted-foreground">Required, up to 4,000 characters.</span>
              <Textarea
                id="bulk-review-comments"
                value={comments}
                onChange={(event) => setComments(event.target.value)}
                maxLength={4000}
                rows={3}
                disabled={loading}
                placeholder="Add the same note to each successful request."
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={loading || preflight.summary.eligible === 0 || (activeAction === 'request_changes' && !comments.trim())} onClick={execute}>
              {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              Confirm and {actionLabel(activeAction).toLowerCase()}
            </Button>
            <Button type="button" variant="ghost" disabled={loading} onClick={() => setPreflight(null)}>
              Cancel
            </Button>
          </div>
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm" aria-label="Checked project details">
            {preflight.items.map((item) => (
              <li key={item.publicId} className="flex flex-col gap-1 border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="font-medium text-foreground">{item.title} <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span></span>
                <span className="text-muted-foreground">Status: {bulkStatusLabel(item.status)} — {bulkDispositionLabel(item.disposition)}</span>
                {item.reasons.map((reason, reasonIndex) => <span key={`${item.publicId}-${reason.code}-${reasonIndex}`} className="text-destructive">{reason.message}</span>)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {execution && (
        <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-3 border-t border-border pt-3 focus-visible:outline-none" role="status">
          <p className="text-sm font-medium text-foreground">
            Finished: {execution.summary.successful} completed, {execution.summary.blocked} blocked,{' '}
            {execution.summary.alreadyComplete} already complete, {execution.summary.invalidOrStale} needs refresh or cannot continue,{' '}
            {execution.summary.failed} did not complete.
          </p>
          <ul className="flex flex-col gap-2 text-sm" aria-label="Review results">
            {execution.items.map((item) => (
              <li key={item.publicId} className="flex flex-wrap items-center gap-2">
                {item.outcome === 'successful' ? <CheckCircle2 className="size-4 text-success" aria-hidden="true" /> : <XCircle className="size-4 text-muted-foreground" aria-hidden="true" />}
                <span className="font-mono text-xs text-muted-foreground">{item.publicId}</span>
                <span className="text-foreground">{bulkStatusLabel(item.status)} — {bulkOutcomeLabel(item.outcome)}</span>
                {item.reasons[0] && <span className="text-muted-foreground">{item.reasons[0].message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
