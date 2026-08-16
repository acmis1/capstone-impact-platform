'use client';

import { useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ShieldAlert } from 'lucide-react';
import { canExecuteLocalArchive, initialLocalArchiveState, localArchiveReducer } from './localArchiveState';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

export function LocalArchivePanel({ publicId }: { publicId: string }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(localArchiveReducer, initialLocalArchiveState);
  const inFlight = useRef(false);
  const reasonId = 'local-archive-reason';

  async function execute() {
    if (inFlight.current || !canExecuteLocalArchive(state)) return;
    inFlight.current = true;
    dispatch({ type: 'START' });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/local-archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archiveReason: state.reason }) });
      const data = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !data.success) throw new Error('Local archive could not be completed.');
      dispatch({ type: 'SUCCESS', resultCode: data.result.resultCode });
      router.refresh();
    } catch {
      dispatch({ type: 'FAIL', error: 'Local archive could not be completed. Please try again.' });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-xs sm:text-sm">
      <div>
        <div className="flex items-center gap-2"><Archive className="h-4 w-4 text-warning" aria-hidden="true" /><h4 className="text-sm font-semibold text-foreground">Local test archive</h4></div>
        <p className="mt-1 text-sm text-muted-foreground">Manage the project&apos;s local showcase lifecycle without changing the live showcase.</p>
      </div>

      <Alert variant="warning" icon={ShieldAlert} title="What this does">
        <p className="text-sm text-muted-foreground">Removes the project from the Local Supabase showcase feed and archives the database record.</p>
        <p className="mt-2 text-sm text-muted-foreground"><span className="font-medium text-foreground">What this does not do:</span> remove Duda content or delete public media.</p>
      </Alert>

      <div className="flex flex-col gap-2">
        <Label htmlFor={reasonId} isRequired>Archive reason</Label>
        <Textarea id={reasonId} rows={3} value={state.reason} disabled={state.pending || state.success !== null} maxLength={4000} onChange={(event) => dispatch({ type: 'REASON', reason: event.target.value })} />
        <p className="text-xs text-muted-foreground">{state.reason.length}/4000 characters</p>
      </div>

      <label className="flex items-start gap-2 text-sm text-foreground">
        <input type="checkbox" checked={state.acknowledged} disabled={state.pending || state.success !== null} onChange={(event) => dispatch({ type: 'ACK', value: event.target.checked })} className="mt-0.5 h-4 w-4 rounded border-input" />
        <span>I understand this removes the project from the local test showcase feed and archives the project in Local Supabase. It does not remove Duda content or delete public media.</span>
      </label>

      <div><Button type="button" variant="destructive" disabled={!canExecuteLocalArchive(state)} onClick={execute} isLoading={state.pending}>{state.pending ? 'Archiving from local showcase' : 'Archive and remove from local showcase'}</Button></div>
      {state.error && <Alert variant="destructive" title="Archive unavailable" description={state.error} />}
      {state.success && <Alert variant="success" title={state.success === 'ALREADY_COMPLETED' ? 'Local archive was already completed.' : 'Local archive completed.'} />}
    </div>
  );
}
