'use client';

import { useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FileCheck2, FlaskConical } from 'lucide-react';
import {
  canExecutePublication,
  initialPublicationPreparationState,
  publicationPreparationReducer,
  type PublicationExecutionTarget,
  type PublicationPlanEvidence,
  type PublicationSuccessEvidence,
  shouldShowPublicationExecution,
} from './publicationPreparationState';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';

interface PublicationPreparationPanelProps {
  publicId: string;
  ready: boolean;
  canPrepare: boolean;
  executionTarget: PublicationExecutionTarget | null;
}

export function PublicationPreparationPanel({ publicId, ready, canPrepare, executionTarget }: PublicationPreparationPanelProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(publicationPreparationReducer, initialPublicationPreparationState);
  const inFlightRef = useRef(false);

  if (!canPrepare || (!ready && state.success === null)) return null;

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
    if (inFlightRef.current || !canExecutePublication(canPrepare, executionTarget, state) || executionTarget === null) return;
    inFlightRef.current = true;
    dispatch({ type: 'EXECUTION_STARTED' });
    const isStaging = executionTarget === 'staging';
    const endpoint = isStaging ? 'staging-publication' : 'local-publication';
    const fallbackError = isStaging
      ? 'Staging showcase publication could not be completed.'
      : 'Local publication could not be completed.';
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/${endpoint}`, { method: 'POST' });
      const data = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !data.success) {
        throw new Error(typeof data.error === 'string' ? data.error : fallbackError);
      }
      dispatch({ type: 'EXECUTION_SUCCEEDED', result: data.result as PublicationSuccessEvidence });
      router.refresh();
    } catch (error) {
      dispatch({
        type: 'EXECUTION_FAILED',
        error: error instanceof Error ? error.message : `${fallbackError} Please try again.`,
      });
    } finally {
      inFlightRef.current = false;
    }
  }

  const pending = state.operation !== 'idle';
  const executionEnabled = canExecutePublication(canPrepare, executionTarget, state);
  const isStaging = executionTarget === 'staging';

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-xs sm:text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Review before publishing</h4>
          <p className="mt-1 text-sm text-muted-foreground">Review the project and confirmed details before publishing to the showcase. Reviewing does not publish anything.</p>
        </div>
        <Button type="button" onClick={generate} disabled={pending} isLoading={state.operation === 'planning'}>
          <FileCheck2 aria-hidden="true" />
          {state.operation === 'planning' ? 'Reviewing publication…' : 'Review publication'}
        </Button>
      </div>

      {state.error && <Alert variant="destructive" title="Review unavailable" description={state.error} />}

      {state.plan && (
        <Alert variant="success" icon={CheckCircle2} title="Ready to publish">
          <p className="text-sm text-foreground">Review complete. Nothing has been published yet.</p>
          <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-foreground">Participant confirmation time</dt>
              <dd className="text-muted-foreground">{new Date(state.plan.confirmedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Projects on showcase</dt>
              <dd className="text-muted-foreground">{state.plan.recordCount}</dd>
            </div>
          </dl>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Technical details</summary>
            <dl className="mt-2 space-y-1">
              <div><dt className="inline font-medium text-foreground">Project ID:</dt> <dd className="inline font-mono break-all">{state.plan.publicId}</dd></div>
              <div><dt className="inline font-medium text-foreground">Snapshot ID:</dt> <dd className="inline font-mono break-all">{state.plan.confirmedPreviewId}</dd></div>
              <div><dt className="inline font-medium text-foreground">SHA-256 hash:</dt> <dd className="inline font-mono break-all">{state.plan.feedHash}</dd></div>
            </dl>
          </details>
        </Alert>
      )}

      {shouldShowPublicationExecution(canPrepare, executionTarget, state) && (
        <div className="flex flex-col gap-4 border-t border-border pt-5">
          <div>
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-warning" aria-hidden="true" />
              <h4 className="text-sm font-semibold text-foreground">{isStaging ? 'Publish to test showcase' : 'Publish to local test showcase'}</h4>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {isStaging
                ? 'This project will become visible on the test showcase. The live public showcase will not be changed.'
                : 'This test action publishes only to the disposable Local Supabase environment. It does not affect the live showcase.'}
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={state.acknowledged}
              disabled={pending || state.success !== null}
              onChange={(event) => dispatch({ type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: event.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-input"
            />
            <span>
              {isStaging
                ? 'I understand this project will be visible on the test showcase and the live public showcase is not affected.'
                : 'I understand this publishes only to the disposable Local Supabase test environment.'}
            </span>
          </label>
          <div>
            <Button type="button" onClick={execute} disabled={!executionEnabled} isLoading={state.operation === 'executing'}>
              {state.operation === 'executing'
                ? (isStaging ? 'Publishing to test showcase…' : 'Publishing to local showcase…')
                : (isStaging ? 'Publish to test showcase' : 'Publish to local test showcase')}
            </Button>
          </div>
        </div>
      )}

      {state.success && (
        <Alert
          variant="success"
          title={state.success.resultCode === 'ALREADY_COMPLETED'
            ? (isStaging ? 'Already on test showcase' : 'Already published locally')
            : (isStaging ? 'Published to test showcase' : 'Published locally')}
        >
          <p className="text-sm text-foreground">
            {isStaging ? 'This project is now visible on the test showcase.' : 'This project is now published in the local test environment.'}
          </p>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Technical details</summary>
            <dl className="mt-2 space-y-1">
              <div><dt className="inline font-medium text-foreground">Projects on showcase:</dt> <dd className="inline">{state.success.recordCount}</dd></div>
              <div><dt className="inline font-medium text-foreground">SHA-256 hash:</dt> <dd className="inline font-mono break-all">{state.success.feedHash}</dd></div>
              <div><dt className="inline font-medium text-foreground">Snapshot ID:</dt> <dd className="inline font-mono break-all">{state.success.snapshotId}</dd></div>
              {state.success.feedPublicUrl && (
                <div><dt className="inline font-medium text-foreground">Feed URL:</dt> <dd className="inline break-all"><a className="underline" href={state.success.feedPublicUrl} target="_blank" rel="noopener noreferrer">{state.success.feedPublicUrl}</a></dd></div>
              )}
            </dl>
          </details>
        </Alert>
      )}
    </div>
  );
}
