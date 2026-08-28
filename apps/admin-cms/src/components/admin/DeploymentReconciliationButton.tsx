'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';

export function DeploymentReconciliationButton({
  publicId,
  unavailableReason = null,
}: {
  publicId: string;
  unavailableReason?: string | null;
}) {
  const router = useRouter();
  const unavailableDescriptionId = React.useId();
  const [pending, setPending] = React.useState(false);
  // The raw backend code stays available for diagnostics, but never as the primary staff message.
  const [message, setMessage] = React.useState<{ text: string; code?: string } | null>(null);
  async function reconcile() {
    if (unavailableReason) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/deployment-reconciliation`, { method: 'POST' });
      const body = await response.json() as { success?: boolean; code?: string };
      if (body.success) {
        setMessage({ text: 'Showcase status repaired.' });
        router.refresh();
      } else {
        setMessage({
          text: 'The showcase status could not be repaired. Nothing was changed. Try again, and ask an administrator for help if it keeps stopping.',
          code: body.code || 'RECONCILIATION_FAILED',
        });
      }
    } catch {
      setMessage({ text: 'The showcase status could not be repaired. Nothing was changed. Check your connection and try again.' });
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={reconcile}
        disabled={pending || Boolean(unavailableReason)}
        aria-describedby={unavailableReason ? unavailableDescriptionId : undefined}
        className="w-fit"
      >
        {pending ? 'Repairing…' : 'Repair showcase status'}
      </Button>
      {unavailableReason && (
        <span id={unavailableDescriptionId} className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          {unavailableReason}
        </span>
      )}
      {message && (
        <>
          <span role="status" className="text-sm font-medium leading-relaxed text-foreground">{message.text}</span>
          {message.code && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer rounded-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">Technical details</summary>
              <p className="mt-1 font-mono">{message.code}</p>
            </details>
          )}
        </>
      )}
    </div>
  );
}
