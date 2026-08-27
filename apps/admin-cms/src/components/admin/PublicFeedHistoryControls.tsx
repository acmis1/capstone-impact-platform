'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';

interface Preparation {
  preparationHandle: string;
  targetVersionNumber: number;
  targetHash: string;
  targetRecordCount: number;
  currentVersionNumber: number;
  currentHash: string;
  currentRecordCount: number;
  diff: {
    addedPublicIds?: string[];
    removedPublicIds?: string[];
    retainedUnchangedPublicIds?: string[];
    changedPublicIds?: string[];
  };
  lifecycleDrift: {
    archivedTargetMembers?: string[];
    lifecyclePublishedOutsideTarget?: string[];
    currentRecordDrift?: { archivedPublicIds?: string[]; changedPublicIds?: string[] };
  };
  requiredAcknowledgement: string;
  expiresAt: string;
}

export function PublicFeedHistoryControls(props: {
  canPublish: boolean;
  historyActive: boolean;
  rollbackAvailable: boolean;
  targetVersionNumber: number | null;
  targetIsCurrent: boolean;
  recoveryAvailable: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [preparation, setPreparation] = React.useState<Preparation | null>(null);
  const [acknowledgement, setAcknowledgement] = React.useState('');

  if (!props.canPublish) return null;

  async function activate() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/public-feed/activation', { method: 'POST' });
      const body = await response.json() as { success?: boolean; code?: string };
      setMessage(body.success ? 'Showcase publishing is active.' : `Setup stopped: ${body.code || 'ACTIVATION_FAILED'}.`);
      if (body.success) router.refresh();
    } catch {
      setMessage('Showcase publishing setup could not be completed.');
    } finally {
      setPending(false);
    }
  }

  async function prepareRollback() {
    if (!props.targetVersionNumber) return;
    setPending(true);
    setMessage(null);
    setPreparation(null);
    setAcknowledgement('');
    try {
      const response = await fetch('/api/public-feed/rollback/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionNumber: props.targetVersionNumber }),
      });
      const body = await response.json() as { success?: boolean; code?: string; result?: Preparation };
      if (!body.success || !body.result) {
        setMessage(`Rollback preparation stopped: ${body.code || 'PREPARATION_FAILED'}.`);
      } else {
        setPreparation(body.result);
      }
    } catch {
      setMessage('Rollback preparation could not be completed.');
    } finally {
      setPending(false);
    }
  }

  async function executeRollback() {
    if (!preparation || acknowledgement !== preparation.requiredAcknowledgement) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/public-feed/rollback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preparationHandle: preparation.preparationHandle,
          acknowledgement,
        }),
      });
      const body = await response.json() as { success?: boolean; code?: string };
      if (body.success) {
        setMessage('Rollback completed successfully.');
        setPreparation(null);
        setAcknowledgement('');
        router.refresh();
      } else {
        setMessage(`Rollback stopped: ${body.code || 'ROLLBACK_FAILED'}.`);
      }
    } catch {
      setMessage('Rollback could not be completed.');
    } finally {
      setPending(false);
    }
  }

  async function recover() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/public-feed/recovery', { method: 'POST' });
      const body = await response.json() as { success?: boolean; code?: string };
      setMessage(body.success
        ? 'Publishing status was safely recovered.'
        : `Recovery remains blocked: ${body.code || 'RECOVERY_FAILED'}.`);
      if (body.success) router.refresh();
    } catch {
      setMessage('Publishing recovery could not be completed.');
    } finally {
      setPending(false);
    }
  }

  // If history is active, no recovery needed, and rollback is not being shown, return minimal/advanced controls
  if (props.historyActive && !props.recoveryAvailable && !props.rollbackAvailable) {
    return message ? <p role="status" className="text-sm font-medium text-foreground">{message}</p> : null;
  }

  return (
    <div className="flex flex-col gap-4">
      {props.recoveryAvailable && (
        <section aria-labelledby="publishing-recovery-heading" className="rounded-xl border border-warning/40 bg-warning/5 p-5 shadow-xs">
          <h2 id="publishing-recovery-heading" className="text-base font-semibold text-foreground">Publishing recovery required</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            A previous publishing action did not finish cleanly. Publishing is paused until it is safely recovered.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={recover} disabled={pending}>
              {pending ? 'Recovering…' : 'Recover publishing status'}
            </Button>
          </div>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Technical recovery details</summary>
            <p className="mt-1 leading-relaxed">
              Takeover is available only after the current lease and any Storage uncertainty fence expire. Bound operations replay their exact durable intent; unbound reservations are safely released.
            </p>
          </details>
        </section>
      )}

      {!props.historyActive && (
        <section aria-labelledby="publishing-setup-heading" className="rounded-xl border border-border-structural bg-card p-5 shadow-xs">
          <h2 id="publishing-setup-heading" className="text-base font-semibold text-foreground">Showcase setup required</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Showcase publishing needs to be set up before projects can be published.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" onClick={activate} disabled={pending}>
              {pending ? 'Setting up…' : 'Set up showcase publishing'}
            </Button>
          </div>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Technical setup details</summary>
            <p className="mt-1 leading-relaxed">
              Activation verifies the existing canonical Storage artifact against the current lifecycle-published projection before creating version 1.
            </p>
          </details>
        </section>
      )}

      {props.historyActive && props.rollbackAvailable && props.targetVersionNumber && !props.targetIsCurrent && (
        <details className="rounded-xl border border-border-structural bg-card p-5 shadow-xs">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">Advanced rollback tools (Local test only)</summary>
          <div className="mt-4 space-y-4 text-sm">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Preparation performs no public write. Rollback execution is available only in an explicitly enabled disposable Local runtime.
            </p>
            <Button type="button" variant="outline" onClick={prepareRollback} disabled={pending || !props.rollbackAvailable}>
              {pending ? 'Preparing…' : `Prepare rollback to version ${props.targetVersionNumber}`}
            </Button>
            {preparation && (
              <div className="space-y-4 rounded-lg border border-warning/40 bg-warning/5 p-4">
                <div>
                  <h3 className="font-semibold text-foreground">Prepared rollback evidence</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Current version {preparation.currentVersionNumber} ({preparation.currentRecordCount} records) → version {preparation.targetVersionNumber} ({preparation.targetRecordCount} records).
                  </p>
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="font-medium text-muted-foreground">Added by rollback</dt><dd>{preparation.diff.addedPublicIds?.join(', ') || 'None'}</dd></div>
                  <div><dt className="font-medium text-muted-foreground">Removed by rollback</dt><dd>{preparation.diff.removedPublicIds?.join(', ') || 'None'}</dd></div>
                  <div><dt className="font-medium text-muted-foreground">Content changed</dt><dd>{preparation.diff.changedPublicIds?.join(', ') || 'None'}</dd></div>
                  <div><dt className="font-medium text-muted-foreground">Archived members restored</dt><dd>{preparation.lifecycleDrift.archivedTargetMembers?.join(', ') || 'None'}</dd></div>
                </dl>
                <div>
                  <label htmlFor="rollback-acknowledgement" className="text-sm font-medium text-foreground">
                    Type the exact acknowledgement
                  </label>
                  <p className="mt-1 break-all rounded bg-muted p-2 font-mono text-xs text-foreground">{preparation.requiredAcknowledgement}</p>
                  <input
                    id="rollback-acknowledgement" value={acknowledgement}
                    onChange={(event) => setAcknowledgement(event.target.value)}
                    autoComplete="off"
                    className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <Button type="button" variant="destructive" onClick={executeRollback}
                  disabled={pending || acknowledgement !== preparation.requiredAcknowledgement}>
                  {pending ? 'Executing…' : 'Execute prepared Local rollback'}
                </Button>
              </div>
            )}
          </div>
        </details>
      )}

      {message && <p role="status" className="text-sm font-medium text-foreground">{message}</p>}
    </div>
  );
}
