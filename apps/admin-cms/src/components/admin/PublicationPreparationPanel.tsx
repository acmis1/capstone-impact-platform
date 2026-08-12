'use client';

import { useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  canExecuteLocalPublication,
  initialPublicationPreparationState,
  publicationPreparationReducer,
  PublicationPlanEvidence,
  PublicationSuccessEvidence,
  shouldShowLocalExecution,
} from './publicationPreparationState';

interface PublicationPreparationPanelProps {
  publicId: string;
  ready: boolean;
  canPrepare: boolean;
  localExecutionAvailable: boolean;
}

export function PublicationPreparationPanel({
  publicId,
  ready,
  canPrepare,
  localExecutionAvailable,
}: PublicationPreparationPanelProps) {
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
      const data = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));
      if (!response.ok || !data.success) throw new Error(data.error || 'Publication plan is unavailable.');
      dispatch({ type: 'PLAN_SUCCEEDED', plan: data.result as PublicationPlanEvidence });
    } catch (cause) {
      dispatch({ type: 'PLAN_FAILED', error: cause instanceof Error ? cause.message : 'Publication plan is unavailable.' });
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
      const data = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));
      if (!response.ok || !data.success) throw new Error(data.error || 'Local publication could not be completed.');
      dispatch({ type: 'EXECUTION_SUCCEEDED', result: data.result as PublicationSuccessEvidence });
      router.refresh();
    } catch (cause) {
      dispatch({ type: 'EXECUTION_FAILED', error: cause instanceof Error ? cause.message : 'Local publication could not be completed.' });
    } finally {
      inFlightRef.current = false;
    }
  }

  const pending = state.operation !== 'idle';
  const executionEnabled = canExecuteLocalPublication(canPrepare, localExecutionAvailable, state);

  return <div style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
    <button type="button" onClick={generate} disabled={pending} style={{ background: '#10B981', color: '#fff', border: 0, borderRadius: 6, padding: '0.55rem 0.9rem', fontWeight: 'bold', cursor: pending ? 'wait' : 'pointer' }}>{state.operation === 'planning' ? 'Generating plan…' : 'Generate publication plan'}</button>
    {state.error && <p style={{ color: '#EF4444' }}>{state.error}</p>}
    {state.plan && <div style={{ marginTop: '0.75rem', padding: '0.8rem', border: '1px solid rgba(16,185,129,.3)', borderRadius: 6 }}><strong>Preparation only — nothing has been published.</strong><br />Project: <code>{state.plan.publicId}</code><br />Confirmed preview: <code>{state.plan.confirmedPreviewId}</code><br />Confirmed: {new Date(state.plan.confirmedAt).toLocaleString()}<br />Candidate records: {state.plan.recordCount}<br />SHA-256: <code style={{ wordBreak: 'break-all' }}>{state.plan.feedHash}</code></div>}
    {shouldShowLocalExecution(canPrepare, localExecutionAvailable, state) && <div style={{ marginTop: '0.9rem', padding: '0.9rem', border: '1px solid rgba(245,158,11,.35)', borderRadius: 6, background: 'rgba(245,158,11,.05)' }}>
      <strong style={{ color: '#F59E0B' }}>Local test publication</strong>
      <p style={{ color: '#D1D5DB', lineHeight: 1.5 }}>This action writes only to the disposable Local Supabase public feed and public-media buckets. It is not production or Duda publication.</p>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <input type="checkbox" checked={state.acknowledged} disabled={pending || state.success !== null} onChange={(event) => dispatch({ type: 'ACKNOWLEDGEMENT_CHANGED', acknowledged: event.target.checked })} />
        <span>I understand this publishes only to the local test environment.</span>
      </label>
      <button type="button" onClick={execute} disabled={!executionEnabled} style={{ background: '#F59E0B', color: '#111827', border: 0, borderRadius: 6, padding: '0.55rem 0.9rem', fontWeight: 'bold', cursor: state.operation === 'executing' ? 'wait' : 'pointer', opacity: executionEnabled ? 1 : 0.6 }}>{state.operation === 'executing' ? 'Executing local publication…' : 'Execute local publication'}</button>
    </div>}
    {state.success && <div role="status" style={{ marginTop: '0.9rem', padding: '0.8rem', border: '1px solid rgba(16,185,129,.3)', borderRadius: 6, color: '#D1FAE5' }}>
      <strong>{state.success.resultCode === 'ALREADY_COMPLETED' ? 'Local publication was already completed.' : 'Local publication completed.'}</strong><br />
      Records: {state.success.recordCount}<br />SHA-256: <code style={{ wordBreak: 'break-all' }}>{state.success.feedHash}</code><br />Snapshot: <code>{state.success.snapshotId}</code>
    </div>}
  </div>;
}
