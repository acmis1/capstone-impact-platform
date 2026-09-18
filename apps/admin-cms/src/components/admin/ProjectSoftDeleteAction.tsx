'use client';

import * as React from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { SoftDeletePreflightResponse } from '../../projects/projectSoftDelete';
import {
  readBoundedSoftDeleteJson,
  runSoftDeleteBatch,
} from '../admin-dashboard/softDeleteCoordinator';
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

export function ProjectSoftDeleteAction({ publicId }: { publicId: string }) {
  const router = useRouter();
  const [preflight, setPreflight] = React.useState<SoftDeletePreflightResponse | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  const requestController = React.useRef<AbortController | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestController.current?.abort();
    };
  }, []);

  const checkEligibility = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch('/api/projects/soft-delete/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicIds: [publicId] }),
        signal: controller.signal,
      });
      const data = await readBoundedSoftDeleteJson(response).catch(() => null);
      if (!mounted.current || controller.signal.aborted) return;
      if (
        !response.ok
        || !data
        || typeof data !== 'object'
        || !('items' in data)
        || !Array.isArray(data.items)
        || data.items.length !== 1
      ) {
        throw new Error('Preflight failed.');
      }
      const next = data as SoftDeletePreflightResponse;
      setPreflight(next);
      if (next.items[0].disposition === 'eligible') setDialogOpen(true);
      else setMessage(next.items[0].reason);
    } catch {
      if (!mounted.current) return;
      setMessage('Deletion eligibility could not be checked. No change was made.');
    } finally {
      clearTimeout(timeout);
      if (!mounted.current) return;
      inFlight.current = false;
      requestController.current = null;
      setLoading(false);
    }
  };

  const execute = async () => {
    if (inFlight.current || !preflight || preflight.items[0].disposition !== 'eligible') return;
    inFlight.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setMessage(null);
    try {
      const result = await runSoftDeleteBatch({
        preflightItems: preflight.items,
        signal: controller.signal,
        isActive: () => mounted.current,
      });
      if (!mounted.current) return;
      const item = result.items[0];
      if (item.outcome === 'DELETED' || item.outcome === 'ALREADY_DELETED') {
        router.replace('/admin');
        return;
      }
      setDialogOpen(false);
      setMessage(item.detail);
    } catch {
      if (!mounted.current) return;
      setDialogOpen(false);
      setMessage('The deletion result is unknown. Inspect the project and audit state before any retry.');
    } finally {
      if (!mounted.current) return;
      inFlight.current = false;
      requestController.current = null;
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button ref={triggerRef} type="button" variant="destructive" disabled={loading} onClick={checkEligibility}>
        {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
        Delete project
      </Button>
      {message && <Alert variant="warning" title="Project was not deleted" description={message} />}

      <AlertDialog open={dialogOpen} onOpenChange={(open) => !loading && setDialogOpen(open)}>
        <AlertDialogContent onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Soft-delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              This changes the lifecycle status to Deleted and hides the project from normal staff workflows.
              It does not physically delete the project row, uploaded assets, participant evidence,
              publication/removal history, feed versions, or audit records. Deleted projects cannot be
              edited, reviewed, published, or restored through the archive-restore workflow.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={loading} onClick={(event) => { event.preventDefault(); void execute(); }}>
              {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              Confirm soft delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
