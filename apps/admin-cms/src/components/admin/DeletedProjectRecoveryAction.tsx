'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { parseDeletedProjectRecoveryResponse } from '../../recovery/deletedProjectMaintenanceResponses';
import { Alert } from '../ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';

export function DeletedProjectRecoveryAction({ publicId, expectedUpdatedAt, expectedDeletedAt, recoveryCode }: {
  publicId: string;
  expectedUpdatedAt: string;
  expectedDeletedAt: string;
  recoveryCode: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [unknown, setUnknown] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const inFlight = React.useRef(false);
  const canRecover = recoveryCode === 'READY_FOR_RECOVERY';

  const recover = async () => {
    if (!canRecover || busy || unknown || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setDialogOpen(false);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/deleted/${encodeURIComponent(publicId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt, expectedDeletedAt }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status >= 500 || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Unknown recovery outcome');
      const envelope = payload as Record<string, unknown>;
      if (response.ok && envelope.success === true) {
        const result = parseDeletedProjectRecoveryResponse(envelope.result, publicId);
        if (result.resultCode !== 'RECOVERED' && result.resultCode !== 'ALREADY_RECOVERED') throw new Error('Contradictory recovery outcome');
        setUnknown(true); // Prevent a second write during navigation.
        router.replace('/admin/projects/' + encodeURIComponent(publicId)); router.refresh();
        return;
      }
      if (response.ok || envelope.success !== false) throw new Error('Unknown recovery outcome');
      setMessage('Recovery was refused. Reload the current record and review its deletion and public-removal evidence.');
    } catch {
      setUnknown(true);
      setMessage('The recovery result is unknown. Reload the tombstone before trying again; do not retry yet.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button ref={triggerRef} type="button" disabled={!canRecover || busy || unknown} onClick={() => setDialogOpen(true)}>
        {busy ? 'Recovering…' : 'Recover to private Draft'}
      </Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => window.location.reload()}>Reload project record</Button>
      {!canRecover && <p className="text-sm text-muted-foreground">Recovery unavailable: the retained deletion or public-removal evidence is not coherent.</p>}
      {message && <Alert variant="warning" title={unknown ? 'Recovery outcome unknown' : 'Recovery not completed'} description={message} />}
      <AlertDialog open={dialogOpen} onOpenChange={(open) => !busy && setDialogOpen(open)}>
        <AlertDialogContent onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Recover this deleted project?</AlertDialogTitle>
            <AlertDialogDescription>
              The project will return as a private Draft. Existing media, participant evidence,
              publication history and audit history remain retained; any public mapping is rearmed
              privately and still requires the normal review and publication workflow.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void recover(); }}>
              {busy ? 'Recovering…' : 'Confirm recovery'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
