'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';

export function DeploymentReconciliationButton({ publicId }: { publicId: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  async function reconcile() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/deployment-reconciliation`, { method: 'POST' });
      const body = await response.json() as { success?: boolean; code?: string };
      if (body.success) {
        setMessage('Status repaired.');
        router.refresh();
      } else {
        setMessage(`Repair stopped: ${body.code || 'RECONCILIATION_FAILED'}.`);
      }
    } catch {
      setMessage('Repair could not be completed.');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" onClick={reconcile} disabled={pending}>
        {pending ? 'Repairing…' : 'Repair showcase status'}
      </Button>
      {message && <span role="status" className="text-xs font-medium text-foreground">{message}</span>}
    </div>
  );
}
