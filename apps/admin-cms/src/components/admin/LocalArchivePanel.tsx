'use client';
import { useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { canExecuteLocalArchive, initialLocalArchiveState, localArchiveReducer } from './localArchiveState';

export function LocalArchivePanel({ publicId }: { publicId: string }) {
  const router = useRouter(); const [state, dispatch] = useReducer(localArchiveReducer, initialLocalArchiveState); const inFlight = useRef(false);
  async function execute() {
    if (inFlight.current || !canExecuteLocalArchive(state)) return;
    inFlight.current = true; dispatch({ type: 'START' });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/local-archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archiveReason: state.reason }) });
      const data = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));
      if (!response.ok || !data.success) throw new Error(data.error || 'Local archive could not be completed.');
      dispatch({ type: 'SUCCESS', resultCode: data.result.resultCode }); router.refresh();
    } catch (error) { dispatch({ type: 'FAIL', error: error instanceof Error ? error.message : 'Local archive could not be completed.' }); }
    finally { inFlight.current = false; }
  }
  return <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid rgba(245,158,11,.35)', borderRadius: 8, background: 'rgba(245,158,11,.05)', fontSize: '0.85rem' }}>
    <strong style={{ color: '#F59E0B' }}>Local test archive</strong>
    <p>This removes the project from the Local Supabase showcase feed and archives the database record. It does not remove Duda content or delete public media.</p>
    <label style={{ display: 'block', marginBottom: '.3rem' }}>Archive reason:</label>
    <textarea rows={3} value={state.reason} disabled={state.pending || state.success !== null} maxLength={4000} onChange={(event) => dispatch({ type: 'REASON', reason: event.target.value })} style={{ width: '100%', padding: '.5rem', background: '#0F172A', color: '#fff', border: '1px solid rgba(255,255,255,.15)', borderRadius: 6 }} />
    <label style={{ display: 'flex', gap: '.5rem', margin: '.75rem 0' }}><input type="checkbox" checked={state.acknowledged} disabled={state.pending || state.success !== null} onChange={(event) => dispatch({ type: 'ACK', value: event.target.checked })} /><span>I understand this removes the project from the local test showcase feed and archives the project in Local Supabase. It does not remove Duda content or delete public media.</span></label>
    <button type="button" disabled={!canExecuteLocalArchive(state)} onClick={execute} style={{ padding: '.55rem .9rem', border: 0, borderRadius: 6, background: '#F59E0B', color: '#111827', fontWeight: 'bold', opacity: canExecuteLocalArchive(state) ? 1 : .6 }}>{state.pending ? 'Archiving from local showcase…' : 'Archive and remove from local showcase'}</button>
    {state.error && <p style={{ color: '#EF4444' }}>{state.error}</p>}
    {state.success && <p role="status" style={{ color: '#10B981', fontWeight: 'bold' }}>{state.success === 'ALREADY_COMPLETED' ? 'Local archive was already completed.' : 'Local archive completed.'}</p>}
  </div>;
}
