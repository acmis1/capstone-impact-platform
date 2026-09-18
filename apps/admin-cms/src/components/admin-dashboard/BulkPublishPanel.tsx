'use client';

import * as React from 'react';
import { Globe, LoaderCircle, ShieldAlert } from 'lucide-react';
import type { ProjectIndexRow } from './projectDashboardHelpers';
import {
  BULK_PUBLISH_OUTCOME_LABELS,
  runBulkPublish,
  runBulkPublishPreflight,
  type BulkPublishPreflightResult,
  type BulkPublishRunResult,
  type BulkPublishTarget,
} from './bulkPublishCoordinator';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';

export type BulkPublishExecutionTarget =
  | BulkPublishTarget
  | 'staging-unavailable'
  | 'production-unavailable'
  | null;

interface BulkPublishPanelProps {
  selectedProjects: ProjectIndexRow[];
  canPublish: boolean;
  executionTarget: BulkPublishExecutionTarget;
  sharedBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

function targetName(target: BulkPublishExecutionTarget): string {
  if (target === 'production' || target === 'production-unavailable') {
    return 'Production live feed';
  }
  if (target === 'staging' || target === 'staging-unavailable') {
    return 'Staging test-showcase feed';
  }
  if (target === 'local') {
    return 'Local test-showcase feed';
  }
  return 'Unavailable server target';
}

export function BulkPublishPanel({
  selectedProjects,
  canPublish,
  executionTarget,
  sharedBusy = false,
  onBusyChange,
}: BulkPublishPanelProps) {
  const contextKey = JSON.stringify({
    selectedProjects: selectedProjects.map(({ publicId, title, status }) => ({ publicId, title, status })),
    executionTarget,
    canPublish,
  });
  const [preflight, setPreflight] = React.useState<BulkPublishPreflightResult | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<BulkPublishRunResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const inFlight = React.useRef(false);
  const executionStarted = React.useRef(false);
  const mounted = React.useRef(true);
  const previousContextKey = React.useRef(contextKey);
  const runController = React.useRef<AbortController | null>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const focusTriggerAfterReset = React.useRef(false);

  const executableTarget =
    executionTarget === 'staging-unavailable' || executionTarget === 'production-unavailable'
      ? null
      : executionTarget;

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runController.current?.abort();
    };
  }, []);

  React.useLayoutEffect(() => {
    if (previousContextKey.current === contextKey) return;
    previousContextKey.current = contextKey;
    setAcknowledged(false);
    setError(null);
    runController.current?.abort();

    if (!executionStarted.current) {
      setPreflight(null);
    }
  }, [contextKey]);

  React.useEffect(() => {
    if (result && !running) {
      resultRef.current?.focus();
    }
  }, [result, running]);

  React.useEffect(() => {
    if (!result && focusTriggerAfterReset.current) {
      focusTriggerAfterReset.current = false;
      triggerRef.current?.focus();
    }
  }, [result]);

  const handleCancel = React.useCallback(() => {
    runController.current?.abort();
    setPreflight(null);
    setAcknowledged(false);
    setError(null);
    triggerRef.current?.focus();
  }, []);

  const hasCurrentAccess = canPublish && selectedProjects.length > 0;

  if (!hasCurrentAccess && !running && !result) {
    return null;
  }

  const startPreflight = async () => {
    if (inFlight.current || sharedBusy || !executableTarget) return;
    inFlight.current = true;
    const controller = new AbortController();
    runController.current = controller;
    setChecking(true);
    setError(null);
    setResult(null);
    setAcknowledged(false);
    onBusyChange?.(true);

    try {
      const preflightResult = await runBulkPublishPreflight({
        candidates: selectedProjects,
        signal: controller.signal,
      });
      if (
        mounted.current
        && !controller.signal.aborted
      ) {
        setPreflight(preflightResult);
      }
    } catch (caught) {
      if (
        mounted.current
        && !controller.signal.aborted
      ) {
        setError(caught instanceof Error ? caught.message : 'The preflight check could not be completed.');
        setPreflight(null);
      }
    } finally {
      inFlight.current = false;
      runController.current = null;
      onBusyChange?.(false);
      if (mounted.current) {
        setChecking(false);
      }
    }
  };

  const resetAfterInspection = () => {
    if (running || checking || sharedBusy || !hasCurrentAccess || !executableTarget) return;
    focusTriggerAfterReset.current = true;
    setResult(null);
    setPreflight(null);
    setAcknowledged(false);
    setError(null);
  };

  const execute = async () => {
    if (
      inFlight.current ||
      sharedBusy ||
      !acknowledged ||
      !preflight ||
      !executableTarget ||
      preflight.summary.eligible === 0
    ) {
      return;
    }

    inFlight.current = true;
    executionStarted.current = true;
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    onBusyChange?.(true);

    try {
      const finalResult = await runBulkPublish({
        preflight,
        target: executableTarget,
        signal: controller.signal,
        isActive: () => mounted.current,
        onUpdate: (next) => {
          if (mounted.current) setResult(next);
        },
      });
      if (mounted.current) {
        setResult(finalResult);
        setPreflight(null);
      }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : 'The publication batch could not be completed.');
      }
    } finally {
      executionStarted.current = false;
      inFlight.current = false;
      runController.current = null;
      onBusyChange?.(false);
      if (mounted.current) {
        setRunning(false);
      }
    }
  };

  const isProduction =
    executionTarget === 'production' || executionTarget === 'production-unavailable';
  const unavailable = executableTarget === null;
  const currentPreflight = preflight;
  const eligibleCount = currentPreflight?.summary.eligible ?? 0;

  return (
    <section
      aria-labelledby="bulk-publish-heading"
      aria-busy={running || checking}
      className="flex flex-col gap-3 rounded-lg border border-border-structural bg-card p-4 shadow-xs"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="bulk-publish-heading" className="text-base font-semibold text-foreground">
            Publish selected approved projects
          </h2>
          <p className="text-sm text-muted-foreground">
            {result?.items.length ?? selectedProjects.length} selected in this batch. Target:{' '}
            <strong>{targetName(result?.target ?? executionTarget)}</strong>.
          </p>
        </div>
        <Globe className="size-5 text-primary" aria-hidden="true" />
      </div>

      <p className="text-xs text-muted-foreground">
        Up to 50 projects are checked via preflight and published sequentially through existing
        canonical feed writers. Feed writes are never parallelized, and this operation never calls Duda
        Publish/Republish.
      </p>

      {unavailable ? (
        <Alert
          variant="warning"
          icon={ShieldAlert}
          title="Bulk publication unavailable"
          description={
            isProduction
              ? 'Production live publication requires separate institutional enablement and verified production target identity. No request can be made from this dashboard state.'
              : 'The named publication target is disabled or its server-verified runtime identity is unavailable. No request can be made.'
          }
        />
      ) : !result && hasCurrentAccess ? (
        <Button
          ref={triggerRef}
          type="button"
          disabled={sharedBusy || checking || running}
          onClick={startPreflight}
          className="self-start"
        >
          {checking && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          Review publication batch
        </Button>
      ) : null}

      {checking && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm text-muted-foreground">
            Checking publication readiness and preflight plans for the selected projects…
          </p>
          <Button type="button" variant="ghost" onClick={handleCancel}>
            Cancel preflight check
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {currentPreflight && !running && !result && executableTarget && hasCurrentAccess && (
        <div
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              handleCancel();
            }
          }}
          className="flex flex-col gap-3 border-t border-border pt-3"
        >
          <p className="text-sm text-foreground">
            Checked {currentPreflight.summary.total} project{currentPreflight.summary.total === 1 ? '' : 's'}:{' '}
            <strong>{currentPreflight.summary.eligible}</strong> ready to publish,{' '}
            <strong>{currentPreflight.summary.blocked}</strong> blocked or not ready,{' '}
            <strong>{currentPreflight.summary.alreadyComplete}</strong> already complete,{' '}
            <strong>{currentPreflight.summary.ineligible}</strong> ineligible.
          </p>

          <ul
            className="max-h-64 space-y-2 overflow-y-auto text-sm"
            aria-label="Projects checked for publication"
          >
            {currentPreflight.items.map((item, index) => (
              <li
                key={`${item.publicId}-${index}`}
                className="border-t border-border pt-2 first:border-0 first:pt-0"
              >
                <span className="font-medium text-foreground">{item.title}</span>{' '}
                <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span>
                <span className="block text-muted-foreground">
                  Status: {item.status} — {item.detail}
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
            <span>
              I confirm the exact target and list above. Completed requests will publish each qualified
              project to the <strong>{targetName(executionTarget)}</strong> feed sequentially.{' '}
              {isProduction
                ? 'Production publication updates the live public showcase feed; Duda presentation must be verified separately.'
                : 'The live production feed is not affected.'}
            </span>
          </label>

          {eligibleCount === 0 && (
            <p role="alert" className="text-sm text-destructive">
              None of the selected rows currently qualify for publication. No request can be made.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={sharedBusy || !acknowledged || eligibleCount === 0}
              onClick={execute}
            >
              Confirm and publish {eligibleCount} approved project{eligibleCount === 1 ? '' : 's'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={sharedBusy}
              onClick={handleCancel}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {running && (
        <div className="flex flex-wrap items-center gap-3" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          <span className="text-sm text-foreground">
            Publishing one project at a time. Keep this page open.
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => runController.current?.abort()}
          >
            Stop batch
          </Button>
          <span className="text-xs text-muted-foreground">
            This stops browser scheduling but cannot cancel server work already in progress; the
            current result will be Unknown and must be inspected.
          </span>
        </div>
      )}

      {result && (
        <div
          ref={resultRef}
          tabIndex={-1}
          role="status"
          className="flex flex-col gap-3 border-t border-border pt-3 focus-visible:outline-none"
        >
          <p className="text-sm font-medium text-foreground">
            Batch result:{' '}
            {result.items.filter((item) => item.outcome === 'COMPLETED').length} completed,{' '}
            {result.items.filter((item) => item.outcome === 'ALREADY_COMPLETED').length} already
            completed / no change,{' '}
            {result.items.filter((item) => item.outcome === 'BLOCKED').length} blocked,{' '}
            {result.items.filter((item) => item.outcome === 'DENIED').length} denied,{' '}
            {result.items.filter((item) => item.outcome === 'FAILURE').length} failed,{' '}
            {result.items.filter((item) => item.outcome === 'UNKNOWN').length} unknown, and{' '}
            {result.items.filter((item) => item.outcome === 'NOT_ATTEMPTED').length} not attempted.
          </p>

          {result.stopped && (
            <Alert
              variant="warning"
              title="Batch stopped"
              description={result.stopReason ?? 'Inspect state before taking further action.'}
            />
          )}

          <ul className="space-y-2 text-sm" aria-label="Bulk publication results">
            {result.items.map((item, index) => (
              <li
                key={`${item.publicId}-${index}`}
                className="border-t border-border pt-2 first:border-0 first:pt-0"
              >
                <span className="font-medium text-foreground">{item.title}</span>{' '}
                <span className="font-mono text-xs text-muted-foreground">({item.publicId})</span>
                <span className="block text-foreground">
                  {BULK_PUBLISH_OUTCOME_LABELS[item.outcome]}
                </span>
                <span className="block text-muted-foreground">{item.detail}</span>
              </li>
            ))}
          </ul>

          <p className="text-xs text-muted-foreground">
            Refresh and inspect project/feed state before explicitly selecting and confirming any
            later retry. This batch never resumes automatically.
          </p>

          {hasCurrentAccess && executableTarget && (
            <Button
              type="button"
              variant="outline"
              disabled={sharedBusy || running}
              onClick={resetAfterInspection}
              className="self-start"
            >
              I inspected state; start a new review
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
