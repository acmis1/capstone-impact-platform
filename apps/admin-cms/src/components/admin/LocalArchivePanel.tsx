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
  NOT_PUBLISHED: 'This project is not in the current published test-showcase data.',
  PUBLICATION_IN_PROGRESS: 'Another publishing action is still running. Wait for it to finish, then refresh before taking further action.',
  RECOVERY_REQUIRED: 'A previous publishing action needs recovery before you continue. Do not retry this removal; use the publishing recovery workflow.',
  CURRENT_FEED_DIVERGED: 'The CMS and published test-showcase data do not currently agree about this project. No removal was performed; an administrator needs to repair the publishing status.',
  STAGING_ARCHIVE_FAILED: 'Removal could not be completed. Please refresh and check the project status before trying again.',
} as const;

const PRODUCTION_FAILURE_MESSAGES = {
  PRODUCTION_ARCHIVE_UNAVAILABLE: 'Live showcase removal is currently unavailable. Please contact an administrator.',
  NOT_PUBLISHED: 'This project is not in the current production feed.',
  PUBLICATION_IN_PROGRESS: 'Another publishing action is still running. Wait for it to finish, then refresh before taking further action.',
  RECOVERY_REQUIRED: 'A previous publishing action needs recovery before you continue. Do not retry this removal; use the publishing recovery workflow.',
  CURRENT_FEED_DIVERGED: 'The CMS and production feed do not currently agree about this project. No removal was performed; an administrator needs to repair the publishing status.',
  PRODUCTION_ARCHIVE_FAILED: 'Live showcase removal could not be completed. Please refresh and check the project status before trying again.',
} as const;

function hostedFailureMessage(data: unknown, production: boolean): string {
  const messages = production ? PRODUCTION_FAILURE_MESSAGES : STAGING_FAILURE_MESSAGES;
  const fallback = production
    ? PRODUCTION_FAILURE_MESSAGES.PRODUCTION_ARCHIVE_FAILED
    : STAGING_FAILURE_MESSAGES.STAGING_ARCHIVE_FAILED;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fallback;
  }
  const code = (data as Record<string, unknown>).code;
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? messages[code as keyof typeof messages]
    : fallback;
}

export function LocalArchivePanel({
  publicId,
  executionTarget = 'local',
}: {
  publicId: string;
  executionTarget?: 'local' | 'staging' | 'production' | 'staging-unavailable' | 'production-unavailable';
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(localArchiveReducer, initialLocalArchiveState);
  const inFlight = useRef(false);
  const isProduction = executionTarget === 'production' || executionTarget === 'production-unavailable';
  const isStaging = executionTarget === 'staging' || executionTarget === 'staging-unavailable';
  const isHosted = isStaging || isProduction;
  const isUnavailable = executionTarget === 'staging-unavailable' || executionTarget === 'production-unavailable';
  const reasonId = `${executionTarget}-archive-reason`;

  async function execute() {
    if (inFlight.current || !canExecuteLocalArchive(state)) return;
    inFlight.current = true;
    dispatch({ type: 'START' });
    try {
      const endpoint = isProduction ? 'production-archive' : isStaging ? 'staging-archive' : 'local-archive';
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archiveReason: state.reason }) });
      const data = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !data.success) {
        if (isHosted) {
          dispatch({ type: 'FAIL', error: hostedFailureMessage(data, isProduction) });
          return;
        }
        throw new Error();
      }
      const resultCode = data?.result?.resultCode;
      if (resultCode !== 'COMPLETED' && resultCode !== 'ALREADY_COMPLETED') throw new Error();
      dispatch({ type: 'SUCCESS', resultCode });
      router.refresh();
    } catch {
      dispatch({ type: 'FAIL', error: isHosted
        ? hostedFailureMessage(null, isProduction)
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
          description={isProduction
            ? 'Live showcase removal is disabled or the production runtime identity is unavailable. No removal was attempted; contact an administrator.'
            : 'Showcase removal is disabled or its runtime identity is unavailable. No removal was attempted; contact an administrator.'}
        />
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-xs sm:text-sm">
      <div>
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-warning" aria-hidden="true" />
          <h4 className="text-sm font-semibold text-foreground">
            {isProduction ? 'Remove from live showcase feed' : isStaging ? 'Remove from test showcase' : 'Remove from local test showcase'}
          </h4>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {isProduction
            ? 'Remove this project from the production feed and archive the record in the CMS. The live Duda showcase may change when it next fetches the feed.'
            : isStaging
              ? 'Remove this project from published test-showcase data and archive the record in the CMS. The live public showcase is not affected.'
              : 'Remove this project from the local test showcase and archive the record.'}
        </p>
      </div>

      <Alert variant="warning" icon={ShieldAlert} title="What happens when you remove this project">
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
          <li>{isProduction
            ? 'The project will be removed from the production feed. Verify the exact feed and live Duda presentation afterward.'
            : isStaging
              ? 'The project will be removed from published test-showcase data. Refresh the test showcase afterward to confirm it no longer appears.'
              : 'The project will no longer appear in the local test showcase.'}</li>
          <li>The project record will remain in the CMS with Archived status.</li>
          <li>Uploaded files and media are kept safe and not deleted.</li>
          <li>{isProduction
            ? 'Production feed completion does not by itself prove the Duda presentation changed.'
            : 'The live public showcase is not affected.'}</li>
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
          {isProduction
            ? 'I understand this removes the project from the production feed, archives it in the CMS, and may change the live public showcase. I have institutional removal authority.'
            : isStaging
              ? 'I understand this removes the project from published test-showcase data and archives it in the CMS. The live public showcase is not affected, and uploaded files will not be deleted.'
              : 'I understand this project will be removed from the local test showcase and archived in the CMS.'}
        </span>
      </label>

      <div>
        <Button type="button" variant="destructive" disabled={!canExecuteLocalArchive(state)} onClick={execute} isLoading={state.pending}>
          {state.pending
            ? (isProduction ? 'Removing from live feed…' : isStaging ? 'Removing from test showcase…' : 'Removing from local showcase…')
            : (isProduction ? 'Remove from live showcase feed' : isStaging ? 'Remove from test showcase' : 'Remove from local showcase')}
        </Button>
      </div>

      {state.error && <Alert variant="destructive" title="Removal unavailable" description={state.error} />}

      {state.success && (
        <Alert
          variant="success"
          title={state.success === 'ALREADY_COMPLETED'
            ? (isProduction ? 'Already removed from production feed' : isStaging ? 'Already removed from test showcase publishing' : 'Already removed from local showcase')
            : (isProduction ? 'Removed from production feed' : isStaging ? 'Removed from test showcase publishing' : 'Removed from local showcase')}
          description={isProduction
            ? 'The project is archived and absent from the production feed. Verify the live Duda presentation separately.'
            : isStaging
              ? 'The project has been archived and removed from the published test-showcase data. Refresh the test showcase to confirm it no longer appears.'
              : 'This project has been archived and is no longer shown in the local test showcase.'}
        />
      )}
    </div>
  );
}
