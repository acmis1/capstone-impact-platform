'use client';

import { useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ShieldAlert } from 'lucide-react';
import { canExecuteLocalArchive, initialLocalArchiveState, localArchiveReducer } from './localArchiveState';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

const STAGING_FAILURE_MESSAGES = {
  STAGING_ARCHIVE_UNAVAILABLE: 'Staging archive execution is disabled or its runtime identity is unavailable. Do not retry until an operator restores the staging capability.',
  NOT_PUBLISHED: 'This project is not in the published lifecycle state required for staging archive.',
  PUBLICATION_IN_PROGRESS: 'Another canonical public-feed operation is in progress. Wait for it to finish, then refresh before taking further action.',
  RECOVERY_REQUIRED: 'The canonical public-feed writer has an unresolved durable operation. Do not retry archive; use and complete the public-feed recovery workflow.',
  CURRENT_FEED_DIVERGED: 'The project lifecycle and deployed staging feed disagree. Archive was not executed; operator reconciliation is required.',
  STAGING_ARCHIVE_FAILED: 'Staging showcase archive failed without a specific public result. Review bounded operational status before retrying.',
} as const;

function stagingFailureMessage(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return STAGING_FAILURE_MESSAGES.STAGING_ARCHIVE_FAILED;
  }
  const code = (data as Record<string, unknown>).code;
  return typeof code === 'string' && Object.hasOwn(STAGING_FAILURE_MESSAGES, code)
    ? STAGING_FAILURE_MESSAGES[code as keyof typeof STAGING_FAILURE_MESSAGES]
    : STAGING_FAILURE_MESSAGES.STAGING_ARCHIVE_FAILED;
}

export function LocalArchivePanel({
  publicId,
  executionTarget = 'local',
}: {
  publicId: string;
  executionTarget?: 'local' | 'staging' | 'staging-unavailable';
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(localArchiveReducer, initialLocalArchiveState);
  const inFlight = useRef(false);
  const isStaging = executionTarget !== 'local';
  const isUnavailable = executionTarget === 'staging-unavailable';
  const reasonId = `${executionTarget}-archive-reason`;

  async function execute() {
    if (inFlight.current || !canExecuteLocalArchive(state)) return;
    inFlight.current = true;
    dispatch({ type: 'START' });
    try {
      const endpoint = isStaging ? 'staging-archive' : 'local-archive';
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archiveReason: state.reason }) });
      const data = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !data.success) {
        if (isStaging) {
          dispatch({ type: 'FAIL', error: stagingFailureMessage(data) });
          return;
        }
        throw new Error();
      }
      const resultCode = data?.result?.resultCode;
      if (resultCode !== 'COMPLETED' && resultCode !== 'ALREADY_COMPLETED') throw new Error();
      dispatch({ type: 'SUCCESS', resultCode });
      router.refresh();
    } catch {
      dispatch({ type: 'FAIL', error: isStaging
        ? STAGING_FAILURE_MESSAGES.STAGING_ARCHIVE_FAILED
        : 'Local archive could not be completed. Please try again.' });
    } finally {
      inFlight.current = false;
    }
  }

  if (isUnavailable) {
    return (
      <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-xs sm:text-sm">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-warning" aria-hidden="true" />
          <h4 className="text-sm font-semibold text-foreground">Staging showcase archive</h4>
        </div>
        <Alert
          variant="warning"
          icon={ShieldAlert}
          title="Staging archive unavailable"
          description="Staging archive execution is disabled or its runtime identity is unavailable. No archive was attempted; contact the platform operator before taking further action."
        />
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-xs sm:text-sm">
      <div>
        <div className="flex items-center gap-2"><Archive className="h-4 w-4 text-warning" aria-hidden="true" /><h4 className="text-sm font-semibold text-foreground">{isStaging ? 'Staging showcase archive' : 'Local test archive'}</h4></div>
        <p className="mt-1 text-sm text-muted-foreground">{isStaging
          ? 'Remove the project from the non-production staging feed consumed by the Duda TEST showcase.'
          : 'Manage the project\'s local showcase lifecycle without changing the live showcase.'}</p>
      </div>

      <Alert variant="warning" icon={ShieldAlert} title="What this does">
        <p className="text-sm text-muted-foreground">{isStaging
          ? 'Removes the project from the governed staging public feed and archives the staging database record.'
          : 'Removes the project from the Local Supabase showcase feed and archives the database record.'}</p>
        <p className="mt-2 text-sm text-muted-foreground"><span className="font-medium text-foreground">What this does not do:</span> modify Duda files, affect the live showcase, or delete public media.</p>
      </Alert>

      <div className="flex flex-col gap-2">
        <Label htmlFor={reasonId} isRequired>Archive reason</Label>
        <Textarea id={reasonId} rows={3} value={state.reason} disabled={state.pending || state.success !== null} maxLength={4000} onChange={(event) => dispatch({ type: 'REASON', reason: event.target.value })} />
        <p className="text-xs text-muted-foreground">{state.reason.length}/4000 characters</p>
      </div>

      <label className="flex items-start gap-2 text-sm text-foreground">
        <input type="checkbox" checked={state.acknowledged} disabled={state.pending || state.success !== null} onChange={(event) => dispatch({ type: 'ACK', value: event.target.checked })} className="mt-0.5 h-4 w-4 rounded border-input" />
        <span>{isStaging
          ? 'I understand this removes the project from the staging feed consumed by the Duda TEST showcase and archives the project in staging. It does not modify Duda files, affect the live showcase, or delete public media.'
          : 'I understand this removes the project from the local test showcase feed and archives the project in Local Supabase. It does not modify Duda files, affect the live showcase, or delete public media.'}</span>
      </label>

      <div><Button type="button" variant="destructive" disabled={!canExecuteLocalArchive(state)} onClick={execute} isLoading={state.pending}>{state.pending
        ? (isStaging ? 'Archiving from staging showcase' : 'Archiving from local showcase')
        : (isStaging ? 'Archive and remove from staging showcase' : 'Archive and remove from local showcase')}</Button></div>
      {state.error && <Alert variant="destructive" title="Archive unavailable" description={state.error} />}
      {state.success && <Alert variant="success" title={state.success === 'ALREADY_COMPLETED'
        ? (isStaging ? 'Staging showcase archive was already completed.' : 'Local archive was already completed.')
        : (isStaging ? 'Staging showcase archive completed.' : 'Local archive completed.')} />}
    </div>
  );
}
