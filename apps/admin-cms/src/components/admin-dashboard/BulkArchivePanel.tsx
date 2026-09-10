'use client';

import * as React from 'react';
import { Archive, LoaderCircle, ShieldAlert } from 'lucide-react';
import type { ProjectIndexRow } from './projectDashboardHelpers';
import {
  BULK_ARCHIVE_OUTCOME_LABELS,
  BULK_ARCHIVE_REASON_MAX_LENGTH,
  prepareBulkArchiveItems,
  runBulkArchive,
  validateBulkArchiveReason,
  type BulkArchiveRunResult,
  type BulkArchiveTarget,
} from './bulkArchiveCoordinator';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

export type BulkArchiveExecutionTarget = BulkArchiveTarget | 'staging-unavailable' | 'production-unavailable' | null;

interface BulkArchivePanelProps {
  selectedProjects: ProjectIndexRow[];
  canArchive: boolean;
  executionTarget: BulkArchiveExecutionTarget;
  sharedBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

function targetName(target: BulkArchiveExecutionTarget): string {
  if (target === 'production' || target === 'production-unavailable') return 'Production live feed';
  if (target === 'staging' || target === 'staging-unavailable') return 'Staging test-showcase feed';
  if (target === 'local') return 'Local test-showcase feed';
  return 'Unavailable server target';
}

export function BulkArchivePanel({
  selectedProjects,
  canArchive,
  executionTarget,
  sharedBusy = false,
  onBusyChange,
}: BulkArchivePanelProps) {
  const [confirming, setConfirming] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<BulkArchiveRunResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  const runController = React.useRef<AbortController | null>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);
  const selectionKey = JSON.stringify(selectedProjects.map(({ publicId, title, status }) => ({ publicId, title, status })));
  const prepared = React.useMemo(() => prepareBulkArchiveItems(selectedProjects), [selectedProjects]);
  const eligibleCount = prepared.items.filter((item) => item.outcome === 'NOT_ATTEMPTED').length;
  const executableTarget = executionTarget === 'staging-unavailable' || executionTarget === 'production-unavailable'
    ? null
    : executionTarget;

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runController.current?.abort();
    };
  }, []);

  React.useEffect(() => {
    if (inFlight.current) {
      // Any changed reviewed identity invalidates permission to schedule the next request.
      runController.current?.abort();
      return;
    }
    setConfirming(false);
    setReason('');
    setAcknowledged(false);
    setResult(null);
    setError(null);
  }, [selectionKey, executionTarget, canArchive]);

  React.useEffect(() => {
    if (result && !running) resultRef.current?.focus();
  }, [result, running]);

  if (!canArchive || selectedProjects.length === 0) return null;

  const execute = async () => {
    const validatedReason = validateBulkArchiveReason(reason);
    if (inFlight.current || sharedBusy || !acknowledged || !validatedReason || !executableTarget || eligibleCount === 0) return;
    inFlight.current = true;
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    onBusyChange?.(true);
    try {
      const finalResult = await runBulkArchive({
        candidates: selectedProjects,
        reason: validatedReason,
        target: executableTarget,
        signal: controller.signal,
        isActive: () => mounted.current,
        onUpdate: (next) => setResult(next),
      });
      if (mounted.current) setResult(finalResult);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'The batch could not be started.');
    } finally {
      inFlight.current = false;
      runController.current = null;
      // Release the lease even when this panel unmounts but the dashboard provider survives.
      onBusyChange?.(false);
      if (mounted.current) setRunning(false);
    }
  };

  const isProduction = executionTarget === 'production' || executionTarget === 'production-unavailable';
  const unavailable = executableTarget === null;

  return (
    <section aria-labelledby="bulk-archive-heading" aria-busy={running} className="flex flex-col gap-3 rounded-lg border border-border-structural bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="bulk-archive-heading" className="text-base font-semibold text-foreground">Archive selected published projects</h2>
          <p className="text-sm text-muted-foreground">
            {selectedProjects.length} selected on this page. Target: <strong>{targetName(result?.target ?? executionTarget)}</strong>.
          </p>
        </div>
        <Archive className="size-5 text-warning" aria-hidden="true" />
      </div>

      <p className="text-xs text-muted-foreground">
        Up to 50 projects are handled sequentially through the existing per-project archive route. This is not an atomic all-or-nothing operation and it never deletes original uploads or media.
      </p>

      {unavailable ? (
        <Alert variant="warning" icon={ShieldAlert} title="Bulk archive unavailable" description={isProduction
          ? 'Production removal requires separate institutional enablement and verified production target identity. No request can be made from this dashboard state.'
          : 'The named archive target is disabled or its server-verified runtime identity is unavailable. No request can be made.'} />
      ) : !confirming && !result ? (
        <Button type="button" variant="destructive" disabled={sharedBusy} onClick={() => setConfirming(true)} className="self-start">
          Review archive batch
        </Button>
      ) : null}

      {confirming && !running && !result && executableTarget && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <Alert variant="warning" icon={ShieldAlert} title="Confirm reversible removal">
            <p className="text-sm text-muted-foreground">
              Exactly {selectedProjects.length} selected project{selectedProjects.length === 1 ? '' : 's'} are listed below; {eligibleCount} currently show Published and qualify for a server request. Server state is authoritative.
            </p>
          </Alert>
          <ul className="max-h-64 space-y-2 overflow-y-auto text-sm" aria-label="Projects selected for archive">
            {prepared.items.map((item, index) => (
              <li key={`${item.publicId}-${index}`} className="border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="font-medium text-foreground">{item.title}</span>{' '}
                <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span>
                {item.outcome === 'INVALID_OR_INELIGIBLE' && <span className="block text-muted-foreground">{item.detail}</span>}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-archive-reason" isRequired>Shared archive reason</Label>
            <Textarea id="bulk-archive-reason" rows={3} value={reason} maxLength={BULK_ARCHIVE_REASON_MAX_LENGTH} disabled={sharedBusy} onChange={(event) => setReason(event.target.value)} />
            <p className="text-xs text-muted-foreground">Required; {reason.length}/{BULK_ARCHIVE_REASON_MAX_LENGTH} characters. The same reason is sent to each qualified canonical request.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" checked={acknowledged} disabled={sharedBusy} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5 size-4" />
            <span>
              I confirm the exact target and list above. Completed requests archive CMS records and remove them from that feed; original assets remain. {isProduction
                ? 'Production can affect the live feed only when separate institutional enablement and identity checks have made this target available; Duda presentation must be verified separately.'
                : 'The live production feed is not affected.'}
            </span>
          </label>
          {eligibleCount === 0 && <p role="alert" className="text-sm text-destructive">None of the selected rows currently qualify as published. No request can be made.</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" disabled={sharedBusy || !acknowledged || !validateBulkArchiveReason(reason) || eligibleCount === 0} onClick={execute}>
              Confirm and archive {eligibleCount} published project{eligibleCount === 1 ? '' : 's'}
            </Button>
            <Button type="button" variant="ghost" disabled={sharedBusy} onClick={() => { setConfirming(false); setReason(''); setAcknowledged(false); }}>Cancel</Button>
          </div>
        </div>
      )}

      {running && (
        <div className="flex flex-wrap items-center gap-3" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          <span className="text-sm text-foreground">Archiving one project at a time. Keep this page open.</span>
          <Button type="button" variant="outline" onClick={() => runController.current?.abort()}>Stop batch</Button>
          <span className="text-xs text-muted-foreground">This stops browser scheduling but cannot cancel server work already in progress; the current result will be Unknown and must be inspected.</span>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {result && (
        <div ref={resultRef} tabIndex={-1} role="status" className="flex flex-col gap-3 border-t border-border pt-3 focus-visible:outline-none">
          <p className="text-sm font-medium text-foreground">
            Batch result: {result.items.filter((item) => item.outcome === 'COMPLETED').length} completed,{' '}
            {result.items.filter((item) => item.outcome === 'ALREADY_COMPLETED').length} already completed/no change,{' '}
            {result.items.filter((item) => item.outcome === 'INVALID_OR_INELIGIBLE').length} invalid or ineligible,{' '}
            {result.items.filter((item) => item.outcome === 'DENIED').length} denied,{' '}
            {result.items.filter((item) => item.outcome === 'FAILURE').length} failed,{' '}
            {result.items.filter((item) => item.outcome === 'UNKNOWN').length} unknown, and{' '}
            {result.items.filter((item) => item.outcome === 'NOT_ATTEMPTED').length} not attempted.
          </p>
          {result.stopped && <Alert variant="warning" title="Batch stopped" description={result.stopReason ?? 'Inspect state before taking further action.'} />}
          <ul className="space-y-2 text-sm" aria-label="Bulk archive results">
            {result.items.map((item, index) => (
              <li key={`${item.publicId}-${index}`} className="border-t border-border pt-2 first:border-0 first:pt-0">
                <span className="font-medium text-foreground">{item.title}</span>{' '}
                <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span>
                <span className="block text-foreground">{BULK_ARCHIVE_OUTCOME_LABELS[item.outcome]}</span>
                <span className="block text-muted-foreground">{item.detail}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Refresh and inspect project/feed state before explicitly selecting and confirming any later retry. This batch never resumes automatically.</p>
        </div>
      )}
    </section>
  );
}
