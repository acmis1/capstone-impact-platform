'use client';

import { useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FileCheck2, FlaskConical } from 'lucide-react';
import {
  canExecuteLocalPublication,
  initialPublicationPreparationState,
  publicationPreparationReducer,
  PublicationPlanEvidence,
  PublicationSuccessEvidence,
  shouldShowLocalExecution,
} from './publicationPreparationState';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';

interface PublicationPreparationPanelProps {
  publicId: string;
  ready: boolean;
  canPrepare: boolean;
  localExecutionAvailable: boolean;
}

export function PublicationPreparationPanel({ publicId, ready, canPrepare, localExecutionAvailable }: PublicationPreparationPanelProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(publicationPreparationReducer, initialPublicationPreparationState);
  const inFlightRef = useRef(false);

  if (!canPrepare || !ready) return null;

  async function generate() {
    if (inFlightRef.current || state.operation !== 'idle') return;
    inFlightRef.current = true;
    dispatch({ type: 'PLAN_STARTED' });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/publication-plan`, { method: 'POST' });
      const data = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !data.success) throw new Error('Publication plan is unavailable.');
      dispatch({ type: 'PLAN_SUCCEEDED', plan: data.result as PublicationPlanEvidence });
    } catch {
      dispatch({ type: 'PLAN_FAILED', error: 'Publication plan is unavailable. Please try again.' });
    } finally {
      inFlightRef.current = false;
    }
  }

  async function execute() {
    if (inFlightRef.current || !canExecuteLocalPublication(canPrepare, localExecutionAvailable, state)) return;
    inFlightRef.current = true;
    dispatch({ type: 'EXECUTION_STARTED' });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/local-publication`, { method: 'POST' });
      const data = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !data.success) throw new Error('Local publication could not be completed.');
      dispatch({ type: 'EXECUTION_SUCCEEDED', result: data.result as PublicationSuccessEvidence });
      router.refresh();
    } catch {
      dispatch({ type: 'EXECUTION_FAILED', error: 'Local publication could not be completed. Please try again.' });
    } finally {
      inFlightRef.current = false;
    }
  }

  const pending = state.operation !== 'idle';
  const executionEnabled = canExecuteLocalPublication(canPrepare, localExecutionAvailable, state);

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-xs sm:text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Publication preparation plan</h4>
          <p className="mt-1 text-sm text-muted-foreground">Create evidence for a publication review. Generating a plan does not publish anything.</p>
        </div>
        <Button type="button" onClick={generate} disabled={pending} isLoading={state.operation === 'planning'}>
          <FileCheck2 aria-hidden="true" />
          {state.operation === 'planning' ? 'Generating plan' : 'Generate publication plan'}
        </Button>
      </div>

      {state.error && <Alert variant="destructive" title="Action unavailable" description={state.error} />}

      {state.plan && (
        <Alert variant="success" icon={CheckCircle2} title="Preparation only — nothing has been published.">
          <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div><dt className="font-medium text-foreground">Confirmed participant snapshot</dt><dd className="font-mono text-muted-foreground break-all">{state.plan.confirmedPreviewId}</dd></div>
            <div><dt className="font-medium text-foreground">Confirmation time</dt><dd className="text-muted-foreground">{new Date(state.plan.confirmedAt).toLocaleString()}</dd></div>
            <div><dt className="font-medium text-foreground">Records prepared</dt><dd className="text-muted-foreground">{state.plan.recordCount}</dd></div>
          </dl>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Technical evidence</summary>
            <dl className="mt-2 space-y-1">
              <div><dt className="inline font-medium text-foreground">Project:</dt> <dd className="inline font-mono break-all">{state.plan.publicId}</dd></div>
              <div><dt className="inline font-medium text-foreground">SHA-256:</dt> <dd className="inline font-mono break-all">{state.plan.feedHash}</dd></div>
            </dl>
          </details>
        </Alert>
      )}

      {shouldShowLocalExecution(canPrepare, localExecutionAvailable, state) && (
        <div className="flex flex-col gap-4 border-t border-border pt-5">
          <div>
            <div className="flex items-center gap-2"><FlaskConical className="h-4 w-4 text-warning" aria-hidden="true" /><h4 className="text-sm font-semibold text-foreground">Local test publication</h4></div>
            <p className="mt-1 text-sm text-muted-foreground">This test action publishes only to the disposable Local Supabase environment. It does not publish to Duda or the live showcase.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" checked={state.acknowledged} disabled={pending || state.success !== null} onChange={(event) => dispatch({ type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: event.target.checked })} className="mt-0.5 h-4 w-4 rounded border-input" />
            <span>I understand this publishes only to the disposable Local Supabase test environment.</span>
          </label>
          <div><Button type="button" variant="outline" onClick={execute} disabled={!executionEnabled} isLoading={state.operation === 'executing'}>{state.operation === 'executing' ? 'Executing local publication' : 'Execute local publication'}</Button></div>
        </div>
      )}

      {state.success && (
        <Alert variant="success" title={state.success.resultCode === 'ALREADY_COMPLETED' ? 'Local publication was already completed.' : 'Local publication completed.'}>
          <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
            <div><dt className="inline font-medium text-foreground">Records:</dt> <dd className="inline">{state.success.recordCount}</dd></div>
            <div><dt className="inline font-medium text-foreground">SHA-256:</dt> <dd className="inline font-mono break-all">{state.success.feedHash}</dd></div>
            <div><dt className="inline font-medium text-foreground">Snapshot:</dt> <dd className="inline font-mono break-all">{state.success.snapshotId}</dd></div>
          </dl>
        </Alert>
      )}
    </div>
  );
}
