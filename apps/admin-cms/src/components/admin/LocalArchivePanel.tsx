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
  STAGING_ARCHIVE_UNAVAILABLE: 'Showcase removal is currently unavailable. Please contact an administrator.',
  NOT_PUBLISHED: 'This project is not currently published on the showcase.',
  PUBLICATION_IN_PROGRESS: 'Another publishing action is still running. Wait for it to finish, then refresh before taking further action.',
  RECOVERY_REQUIRED: 'A previous publishing action needs recovery before you continue. Do not retry this removal; use the publishing recovery workflow.',
  CURRENT_FEED_DIVERGED: 'The CMS and showcase do not currently agree about this project. No removal was performed; an administrator needs to repair the publishing status.',
  STAGING_ARCHIVE_FAILED: 'Removal could not be completed. Please refresh and check the project status before trying again.',
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
          <h4 className="text-sm font-semibold text-foreground">Showcase removal unavailable</h4>
        </div>
        <Alert
          variant="warning"
          icon={ShieldAlert}
          title="Removal unavailable"
          description="Showcase removal is disabled or its runtime identity is unavailable. No removal was attempted; contact an administrator."
        />
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-xs sm:text-sm">
      <div>
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-warning" aria-hidden="true" />
          <h4 className="text-sm font-semibold text-foreground">{isStaging ? 'Remove from test showcase' : 'Remove from local test showcase'}</h4>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {isStaging
            ? 'Remove this project from the test showcase and archive the record in the CMS.'
            : 'Remove this project from the local test showcase and archive the record.'}
        </p>
      </div>

      <Alert variant="warning" icon={ShieldAlert} title="What happens when you remove this project">
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
          <li>The project will no longer appear on the test showcase.</li>
          <li>The project record will remain in the CMS with Archived status.</li>
          <li>Uploaded files and media are kept safe and not deleted.</li>
          <li>The live public showcase is not affected.</li>
        </ul>
      </Alert>

      <div className="flex flex-col gap-2">
        <Label htmlFor={reasonId} isRequired>Reason for removal</Label>
        <Textarea id={reasonId} rows={3} value={state.reason} disabled={state.pending || state.success !== null} maxLength={4000} onChange={(event) => dispatch({ type: 'REASON', reason: event.target.value })} />
        <p className="text-xs text-muted-foreground">{state.reason.length}/4000 characters</p>
      </div>

      <label className="flex items-start gap-2 text-sm text-foreground">
        <input type="checkbox" checked={state.acknowledged} disabled={state.pending || state.success !== null} onChange={(event) => dispatch({ type: 'ACK', value: event.target.checked })} className="mt-0.5 h-4 w-4 rounded border-input" />
        <span>
          {isStaging
            ? 'I understand this project will be removed from the test showcase and archived in the CMS. Uploaded files will not be deleted.'
            : 'I understand this project will be removed from the local test showcase and archived in the CMS.'}
        </span>
      </label>

      <div>
        <Button type="button" variant="destructive" disabled={!canExecuteLocalArchive(state)} onClick={execute} isLoading={state.pending}>
          {state.pending
            ? (isStaging ? 'Removing from test showcase…' : 'Removing from local showcase…')
            : (isStaging ? 'Remove from test showcase' : 'Remove from local showcase')}
        </Button>
      </div>

      {state.error && <Alert variant="destructive" title="Removal unavailable" description={state.error} />}

      {state.success && (
        <Alert
          variant="success"
          title={state.success === 'ALREADY_COMPLETED'
            ? (isStaging ? 'Already removed from test showcase' : 'Already removed from local showcase')
            : (isStaging ? 'Removed from test showcase' : 'Removed from local showcase')}
          description="This project has been archived and is no longer shown on the test showcase."
        />
      )}
    </div>
  );
}
