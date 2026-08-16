'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ParticipantPreviewResponseState, ParticipantPreviewCorrectionResolutionStatus } from '../../domain/participantPreview';
import {
  participantPreviewNotificationStatusLabel,
  type ParticipantPreviewNotificationView,
} from '../../notifications/participantPreviewNotification';
import {
  participantPreviewReminderStatusLabel,
  type ParticipantPreviewReminderView,
} from '../../reminders/participantPreviewReminder';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Clock,
} from 'lucide-react';

interface ActivePreviewState {
  createdAt: string;
  expiresAt: string;
}

interface ParticipantPreviewPanelProps {
  publicId: string;
  canManage: boolean;
  isApprovedEligible: boolean;
  initialActivePreview: ActivePreviewState | null;
  responseState: ParticipantPreviewResponseState;
  stateAvailable: boolean;
  /** Delivery history for the current active preview; null when it was generated without email. */
  notification?: ParticipantPreviewNotificationView | null;
  /** Authoritative recipient, shown read-only. The server resolves it again at execution time. */
  participantContactEmail?: string | null;
  /** Server-side enablement. False hides Generate + Send rather than offering an action that fails. */
  emailDeliveryEnabled?: boolean;
  reminderSchedulingEnabled?: boolean;
  reminders?: ParticipantPreviewReminderView[];
  resolutionStatus?: ParticipantPreviewCorrectionResolutionStatus | null;
  resolutionStateAvailable: boolean;
  canResolveCorrection?: boolean;
  projectStatus?: string;
}

interface GenerateResponse {
  success: boolean;
  error?: string;
  code?: string;
  previewUrl?: string;
  createdAt?: string;
  expiresAt?: string;
  notification?: {
    status?: string;
    message?: string;
    recipient?: string;
    requestedAt?: string;
    failureCode?: string | null;
  };
}

interface RevokeResponse {
  success: boolean;
  error?: string;
  revokedAt?: string;
}

interface StartResolutionResponse {
  success: boolean;
  error?: string;
  correctionRequestId?: string;
  resolutionStartedAt?: string;
  alreadyInProgress?: boolean;
}

interface ReminderMutationResponse {
  success: boolean;
  code?: string;
  message?: string;
}

function toLocalDateTimeInputValue(value: string): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const part = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}` +
    `T${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function ParticipantPreviewPanel({
  publicId,
  canManage,
  isApprovedEligible,
  initialActivePreview,
  responseState,
  stateAvailable,
  notification = null,
  participantContactEmail = null,
  emailDeliveryEnabled = false,
  reminderSchedulingEnabled = false,
  reminders = [],
  resolutionStatus,
  resolutionStateAvailable,
  canResolveCorrection = false,
  projectStatus = 'draft',
}: ParticipantPreviewPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePreview, setActivePreview] = useState<ActivePreviewState | null>(initialActivePreview);
  const [previewResponseState, setPreviewResponseState] = useState<ParticipantPreviewResponseState>(responseState);
  const [justGeneratedUrl, setJustGeneratedUrl] = useState<string | null>(null);
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [scheduledFor, setScheduledFor] = useState('');
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  if (!stateAvailable) {
    return (
      <div role="status" className="p-3.5 rounded-lg bg-warning/10 border border-warning/30 text-xs sm:text-sm text-foreground flex items-start gap-2.5">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <strong className="font-semibold block text-warning">Participant Preview status unavailable.</strong>
          <span className="text-muted-foreground text-xs block mt-0.5">
            Preview actions are temporarily disabled because the current preview state could not be verified.
          </span>
        </div>
      </div>
    );
  }

  if (!resolutionStateAvailable) {
    return (
      <div role="status" className="p-3.5 rounded-lg bg-warning/10 border border-warning/30 text-xs sm:text-sm text-foreground flex items-start gap-2.5">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <strong className="font-semibold block text-warning">Correction-resolution status unavailable.</strong>
          <span className="text-muted-foreground text-xs block mt-0.5">
            Preview and correction-resolution actions are temporarily disabled until authoritative state can be verified.
          </span>
        </div>
      </div>
    );
  }

  // The in-flight guard stops an ordinary accidental double click. It is a convenience, not the
  // safety boundary: the server and database converge duplicate requests on their own.
  const handleGenerate = async (isCorrectionReissue = false, sendEmail = false) => {
    if (inFlightRef.current || pending) return;
    inFlightRef.current = true;
    setPending(true);
    setError(null);
    setDeliveryNotice(null);
    setCopyState('idle');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/participant-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isCorrectionReissue, sendEmail }),
      });
      const data: GenerateResponse = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));

      if (!response.ok || !data.success) {
        if (data.code === 'ACTIVE_PREVIEW_EXISTS') {
          router.refresh();
        }
        throw new Error(data.error || 'Failed to generate participant preview.');
      }

      setJustGeneratedUrl(data.previewUrl || null);
      setActivePreview({ createdAt: data.createdAt || '', expiresAt: data.expiresAt || '' });
      setPreviewResponseState({ type: 'unresponded' });
      setDeliveryNotice(data.notification?.message ?? null);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred while generating the preview.');
    } finally {
      setPending(false);
      inFlightRef.current = false;
    }
  };

  const handleStartResolution = async () => {
    if (inFlightRef.current || pending) return;
    if (!window.confirm('Start correction resolution? This will revoke the current preview link and move the project status back to changes_requested so metadata can be edited.')) {
      return;
    }
    inFlightRef.current = true;
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/participant-preview/correction-resolution`, {
        method: 'POST',
      });
      const data: StartResolutionResponse = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to start correction resolution.');
      }

      setActivePreview(null);
      setJustGeneratedUrl(null);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred while starting correction resolution.');
    } finally {
      setPending(false);
      inFlightRef.current = false;
    }
  };

  const handleRevoke = async () => {
    if (inFlightRef.current || pending) return;
    if (!window.confirm('Revoke this participant preview? The current link will stop working immediately.')) {
      return;
    }
    inFlightRef.current = true;
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/participant-preview`, {
        method: 'DELETE',
      });
      const data: RevokeResponse = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to revoke participant preview.');
      }

      setActivePreview(null);
      setJustGeneratedUrl(null);
      setPreviewResponseState({ type: 'unresponded' });
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred while revoking the preview.');
    } finally {
      setPending(false);
      inFlightRef.current = false;
    }
  };

  const handleCopy = async () => {
    if (!justGeneratedUrl) return;
    try {
      await navigator.clipboard.writeText(justGeneratedUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const handleScheduleReminder = async () => {
    if (inFlightRef.current || pending || !scheduledFor) return;
    const instant = new Date(scheduledFor);
    if (!Number.isFinite(instant.getTime())) {
      setError('Choose a valid reminder date and time.');
      return;
    }
    inFlightRef.current = true;
    setPending(true);
    setError(null);
    setReminderNotice(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(publicId)}/participant-preview/reminders`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledFor: instant.toISOString() }),
        },
      );
      const data: ReminderMutationResponse = await response.json().catch(() => ({
        success: false,
        message: 'Invalid server response.',
      }));
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to schedule the reminder.');
      }
      setReminderNotice(data.message ?? 'Reminder scheduled.');
      setScheduledFor('');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to schedule the reminder.');
    } finally {
      setPending(false);
      inFlightRef.current = false;
    }
  };

  const handleCancelReminder = async (reference: string) => {
    if (inFlightRef.current || pending) return;
    if (!window.confirm('Cancel this future participant preview reminder?')) return;
    inFlightRef.current = true;
    setPending(true);
    setError(null);
    setReminderNotice(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(publicId)}/participant-preview/reminders`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference }),
        },
      );
      const data: ReminderMutationResponse = await response.json().catch(() => ({
        success: false,
        message: 'Invalid server response.',
      }));
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to cancel the reminder.');
      }
      setReminderNotice(data.message ?? 'Reminder cancelled.');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to cancel the reminder.');
    } finally {
      setPending(false);
      inFlightRef.current = false;
    }
  };

  if (!canManage) {
    return (
      <p className="text-xs text-muted-foreground italic">
        You do not have permission to generate or revoke participant preview links.
      </p>
    );
  }

  // Determine current resolution state if any
  const resStatus = resolutionStatus?.status;
  const isInProgress = resStatus === 'in_progress' || (projectStatus === 'changes_requested' && resolutionStatus?.status === 'in_progress');

  const canSendEmail = emailDeliveryEnabled && Boolean(participantContactEmail);
  const currentContactMatchesInitial = Boolean(
    notification && participantContactEmail &&
    notification.recipient.trim().toLowerCase() === participantContactEmail.trim().toLowerCase(),
  );
  const canScheduleReminder = Boolean(
    reminderSchedulingEnabled && activePreview && notification?.status === 'sent' &&
    currentContactMatchesInitial && previewResponseState.type === 'unresponded',
  );

  /**
   * Generate + Send is offered only alongside generation, never as a later action on an existing
   * preview: the secure link is deliberately not stored, so there is nothing left to send once the
   * request that created it has finished.
   */
  const renderGenerateActions = (isCorrectionReissue: boolean, primaryLabel: string) => (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          type="button"
          onClick={() => handleGenerate(isCorrectionReissue, false)}
          disabled={pending}
        >
          {pending ? 'Working…' : primaryLabel}
        </Button>
        {canSendEmail && (
          <Button
            type="button"
            variant="outline"
            onClick={() => handleGenerate(isCorrectionReissue, true)}
            disabled={pending}
          >
            {pending ? 'Working…' : `${primaryLabel} and send email`}
          </Button>
        )}
      </div>
      <div>
        {emailDeliveryEnabled && participantContactEmail && (
          <span className="text-xs text-muted-foreground">
            Email would be sent to <strong className="font-semibold text-foreground">{participantContactEmail}</strong>
          </span>
        )}
        {emailDeliveryEnabled && !participantContactEmail && (
          <span className="text-xs text-muted-foreground italic">
            No participant contact email is recorded for this project, so the link cannot be emailed.
          </span>
        )}
        {!emailDeliveryEnabled && (
          <span className="text-xs text-muted-foreground italic">
            Email delivery is not enabled on this server.
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4 text-xs sm:text-sm">
      {error && (
        <div role="alert" className="p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-xs font-semibold flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {deliveryNotice && (
        <div
          role="status"
          className="p-3 rounded-md bg-success/10 border border-success/30 text-success text-xs font-medium flex items-center gap-2"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{deliveryNotice}</span>
        </div>
      )}

      {reminderNotice && (
        <div
          role="status"
          className="p-3 rounded-md bg-success/10 border border-success/30 text-success text-xs font-medium flex items-center gap-2"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{reminderNotice}</span>
        </div>
      )}

      {justGeneratedUrl && (
        <div className="p-4 rounded-lg bg-success/10 border border-success/30 space-y-2.5">
          <div className="flex items-center gap-2 text-success font-semibold text-xs sm:text-sm">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Preview link generated</span>
          </div>
          <p className="text-xs text-muted-foreground">
            This is the only time the full link is shown. It cannot be recovered later — copy it now.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <code className="bg-background border border-border px-3 py-1.5 rounded text-xs font-mono text-foreground break-all flex-1 select-all">
              {justGeneratedUrl}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCopy}
              className="shrink-0 gap-1.5"
            >
              {copyState === 'copied' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  <span>Copied!</span>
                </>
              ) : copyState === 'failed' ? (
                <>
                  <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                  <span>Copy failed</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Copy</span>
                </>
              )}
            </Button>
          </div>
          {copyState === 'copied' && (
            <span role="status" className="sr-only">Preview link copied to clipboard</span>
          )}
        </div>
      )}

      {/* CASE A: Active preview exists */}
      {activePreview ? (
        <div className="p-4 rounded-lg bg-card border border-border space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap pb-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Badge variant="information" className="font-semibold">Active preview</Badge>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleRevoke}
              disabled={pending}
            >
              {pending ? 'Revoking…' : 'Revoke preview'}
            </Button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <dl className="space-y-2">
              <div>
                <dt className="text-muted-foreground font-medium">Created</dt>
                <dd className="font-semibold text-foreground mt-0.5">
                  {activePreview.createdAt ? new Date(activePreview.createdAt).toLocaleString() : 'N/A'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">Expires</dt>
                <dd className="font-semibold text-foreground mt-0.5">
                  {activePreview.expiresAt ? new Date(activePreview.expiresAt).toLocaleString() : 'N/A'}
                </dd>
              </div>
            </dl>

            <div className="space-y-2">
              <span className="text-muted-foreground font-medium block">Participant response</span>
              <div role="status">
                {previewResponseState.type === 'confirmed' ? (
                  <div className="p-2.5 rounded-md bg-success/10 border border-success/30 text-success text-xs font-semibold flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Participant confirmed on {new Date(previewResponseState.confirmedAt).toLocaleString()}</span>
                  </div>
                ) : previewResponseState.type === 'correction_requested' ? (
                  <div className="p-3 rounded-md bg-warning/10 border border-warning/30 text-warning text-xs space-y-2">
                    <div className="font-semibold flex items-center gap-1.5">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>Correction requested on {new Date(previewResponseState.requestedAt).toLocaleString()}</span>
                    </div>
                    <div className="text-foreground bg-background p-2 rounded border border-border font-normal whitespace-pre-wrap">
                      {previewResponseState.comment}
                    </div>
                    {canResolveCorrection && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleStartResolution}
                        disabled={pending}
                        className="text-warning border-warning/30 hover:bg-warning/10 hover:text-warning font-semibold mt-1"
                      >
                        {pending ? 'Starting resolution…' : 'Start correction resolution'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground italic text-xs">Not yet responded by the participant.</span>
                )}
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-border space-y-2" role="status">
            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">Email delivery</h4>
            {notification ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-muted/40 p-3 rounded-md border border-border">
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <span className="font-semibold text-foreground">{participantPreviewNotificationStatusLabel(notification.status)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Sent to: </span>
                  <span className="font-semibold text-foreground">{notification.recipient}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Requested: </span>
                  <span className="text-foreground">{new Date(notification.requestedAt).toLocaleString()}</span>
                </div>
                {notification.sentAt && (
                  <div>
                    <span className="text-muted-foreground">Delivered: </span>
                    <span className="text-foreground">{new Date(notification.sentAt).toLocaleString()}</span>
                  </div>
                )}
                {notification.failureCode && (
                  <div className="sm:col-span-2 text-destructive">
                    <span className="font-semibold">Reason: </span>
                    <span>{notification.failureCode}</span>
                  </div>
                )}
                {notification.status === 'delivery_unknown' && (
                  <div className="sm:col-span-2 text-warning font-medium mt-1">
                    The message may or may not have reached the participant. It has not been sent again
                    automatically. Revoke this preview and issue a new one if you need to be certain.
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                This preview was generated without email delivery. Its secure link is intentionally not
                stored and cannot be recovered for later sending — revoke it and generate a new preview
                to email a link.
              </p>
            )}
          </div>

          <div className="pt-3 border-t border-border space-y-2.5">
            <div>
              <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">Schedule reminder</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                Reminder emails contain no secure link. The participant must use the link from the
                original preview email.
              </p>
            </div>

            {canScheduleReminder ? (
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                <Input
                  type="datetime-local"
                  value={scheduledFor}
                  max={toLocalDateTimeInputValue(activePreview.expiresAt)}
                  onChange={(event) => setScheduledFor(event.target.value)}
                  disabled={pending}
                  aria-label="Reminder date and time"
                  className="w-full sm:w-auto text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleScheduleReminder}
                  disabled={pending || !scheduledFor}
                >
                  {pending ? 'Working…' : 'Schedule reminder'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Must be before {new Date(activePreview.expiresAt).toLocaleString()}.
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                {!reminderSchedulingEnabled
                  ? 'Reminder scheduling is not enabled on this server.'
                  : notification?.status !== 'sent'
                    ? 'A confirmed successful original preview email is required.'
                    : !currentContactMatchesInitial
                      ? 'The current contact does not match the original email recipient.'
                      : previewResponseState.type !== 'unresponded'
                        ? 'This preview already has a participant response.'
                        : 'This preview is no longer eligible for a future reminder.'}
              </p>
            )}
          </div>
        </div>
      ) : isInProgress ? (
        /* CASE B: Correction in progress (Preview A revoked) */
        <div className="p-4 rounded-lg bg-warning/10 border border-warning/30 space-y-3">
          <div className="flex items-center gap-2 text-warning font-semibold text-xs sm:text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Correction resolution in progress</span>
          </div>
          {resolutionStatus?.comment && (
            <div className="text-xs text-foreground bg-background p-2.5 rounded border border-border whitespace-pre-wrap">
              <strong className="text-foreground">Participant comment:</strong> {resolutionStatus.comment}
            </div>
          )}
          {projectStatus === 'changes_requested' ? (
            <p className="text-xs text-muted-foreground italic">
              Project is currently in <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-foreground">changes_requested</code>. Update project metadata below, then use the review actions to re-approve the project before issuing a corrected preview.
            </p>
          ) : projectStatus === 'approved' && canResolveCorrection ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-success flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Project re-approved! You may now issue a corrected participant preview.</span>
              </p>
              {renderGenerateActions(true, 'Generate corrected participant preview')}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Correction resolution is active.
            </p>
          )}
        </div>
      ) : resolutionStatus?.status === 'resolved' ? (
        /* CASE C: Correction resolved historical info */
        <div className="space-y-3">
          <div className="p-3 rounded-lg bg-success/10 border border-success/30 text-xs sm:text-sm flex items-center gap-2 text-foreground">
            <CheckCircle2 className="h-4 w-4 text-success shrink-0" aria-hidden="true" />
            <span className="font-semibold text-success">Participant correction resolved</span>
            {resolutionStatus.resolvedAt && (
              <span className="text-xs text-muted-foreground">
                on {new Date(resolutionStatus.resolvedAt).toLocaleString()}
              </span>
            )}
          </div>
          {isApprovedEligible && renderGenerateActions(false, 'Generate participant preview')}
        </div>
      ) : isApprovedEligible ? (
        /* CASE D: Normal approved state, no active preview */
        renderGenerateActions(false, 'Generate participant preview')
      ) : (
        <p className="text-xs text-muted-foreground italic">
          Available once the project reaches the approved state.
        </p>
      )}

      {reminders.length > 0 && (
        <div className="pt-4 border-t border-border space-y-3">
          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">Reminder history</h4>
          <div className="grid gap-2.5">
            {reminders.map((reminder) => (
              <div
                key={reminder.reference}
                className="p-3 rounded-md bg-muted/40 border border-border text-xs space-y-1.5 text-foreground"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap font-semibold">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    <span>{participantPreviewReminderStatusLabel(reminder.status)}</span>
                    {!reminder.currentPreview && (
                      <span className="text-muted-foreground font-normal"> · earlier preview</span>
                    )}
                  </span>
                  {reminder.status === 'scheduled' && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => handleCancelReminder(reminder.reference)}
                      disabled={pending}
                      className="h-7 px-2.5 text-xs"
                    >
                      Cancel reminder
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground pt-1">
                  <div><span className="text-foreground font-medium">Scheduled for:</span> {new Date(reminder.scheduledFor).toLocaleString()}</div>
                  <div><span className="text-foreground font-medium">Recipient snapshot:</span> {reminder.recipient}</div>
                  <div><span className="text-foreground font-medium">Scheduled by:</span> {reminder.scheduledBy}</div>
                  <div><span className="text-foreground font-medium">Preview expires:</span> {new Date(reminder.previewExpiresAt).toLocaleString()}</div>
                  {reminder.triggeredAt && <div><span className="text-foreground font-medium">Triggered:</span> {new Date(reminder.triggeredAt).toLocaleString()}</div>}
                  {reminder.cancelledAt && <div><span className="text-foreground font-medium">Cancelled:</span> {new Date(reminder.cancelledAt).toLocaleString()}</div>}
                  {reminder.skipReason && <div><span className="text-foreground font-medium">Skip reason:</span> {reminder.skipReason}</div>}
                  {reminder.delivery && (
                    <div className="sm:col-span-2">
                      <span className="text-foreground font-medium">Delivery:</span>{' '}
                      {participantPreviewNotificationStatusLabel(reminder.delivery.status)}
                      {reminder.delivery.sentAt ? ` on ${new Date(reminder.delivery.sentAt).toLocaleString()}` : ''}
                      {reminder.delivery.failureCode ? ` (${reminder.delivery.failureCode})` : ''}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
