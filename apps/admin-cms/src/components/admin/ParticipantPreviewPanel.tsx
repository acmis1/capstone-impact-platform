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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
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

interface ReminderMutationResponse {
  success: boolean;
  code?: string;
  message?: string;
}

/**
 * A destructive action awaiting explicit confirmation. Consequences are always stated in full and
 * Cancel is offered alongside the confirming control; the server-side guard for each action is
 * unchanged and remains the real boundary.
 */
interface PendingConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

/**
 * Bounded, staff-readable explanation of an email delivery state. Raw transport failure codes are
 * never given invented meaning here — they stay under Technical details for diagnostics.
 */
function deliveryExplanation(
  kind: 'initial' | 'reminder',
  status: string,
  linkAvailableInSession = false,
): string | null {
  if (kind === 'reminder' && status === 'failed') {
    return 'The reminder was not delivered. The existing preview is unchanged. Send another reminder only if it is still eligible.';
  }
  if (kind === 'reminder' && status === 'delivery_unknown') {
    return 'The reminder may or may not have been delivered. The existing preview is unchanged. Send another reminder only if it is still eligible and appropriate.';
  }
  if (status === 'failed') {
    return linkAvailableInSession
      ? 'The preview email was not delivered. The preview link is still available in this session and can be copied and shared through the approved process.'
      : 'The preview email was not delivered. If the preview link is no longer available in this session, revoke this preview and generate a new one before trying email again.';
  }
  if (status === 'delivery_unknown') {
    return linkAvailableInSession
      ? 'The preview email may or may not have been delivered. It has not been sent again automatically. The preview link is still available in this session and can be copied through the approved process.'
      : 'The preview email may or may not have been delivered. It has not been sent again automatically. If a new email is needed and the preview link is no longer available in this session, revoke this preview and generate a new one.';
  }
  return null;
}

function toLocalDateTimeInputValue(value: string): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const part = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}` +
    `T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function formatParticipantPreviewDate(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'N/A';
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
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const inFlightRef = useRef(false);
  /**
   * The control that opened the confirmation. The dialog is controlled rather than trigger-driven,
   * so keyboard focus is returned here explicitly when the dialog closes; without this, dismissing
   * with Escape would drop focus to the document body.
   */
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);

  if (!stateAvailable) {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/8 p-3.5 text-sm text-foreground">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <strong className="block font-semibold text-foreground">Participant Preview status unavailable.</strong>
          <span className="mt-0.5 block text-sm text-foreground-subtle">
            Preview actions are temporarily disabled because the current preview state could not be verified.
          </span>
        </div>
      </div>
    );
  }

  if (!resolutionStateAvailable) {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/8 p-3.5 text-sm text-foreground">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <strong className="block font-semibold text-foreground">Correction-resolution status unavailable.</strong>
          <span className="mt-0.5 block text-sm text-foreground-subtle">
            Preview and correction-resolution actions are temporarily disabled until authoritative state can be verified.
          </span>
        </div>
      </div>
    );
  }

  // The in-flight guard stops an ordinary accidental double click. It is a convenience, not the
  // safety boundary: the server and database converge duplicate requests on their own.
  const handleGenerate = async (isCorrectionReissue = false, sendEmail = false) => {
    if (!canManage || inFlightRef.current || pending) return;
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
      const deliveryStatus = data.notification?.status;
      setDeliveryNotice(deliveryStatus === 'DELIVERY_FAILED'
        ? deliveryExplanation('initial', 'failed', Boolean(data.previewUrl))
        : deliveryStatus === 'DELIVERY_UNKNOWN'
          ? deliveryExplanation('initial', 'delivery_unknown', Boolean(data.previewUrl))
          : data.notification?.message ?? null);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred while generating the preview.');
    } finally {
      setPending(false);
      inFlightRef.current = false;
    }
  };

  const handleRevoke = async () => {
    if (!canManage || inFlightRef.current || pending) return;
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
    if (!canManage || inFlightRef.current || pending || !scheduledFor) return;
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
    if (!canManage || inFlightRef.current || pending) return;
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

  const openConfirmation = (next: PendingConfirmation) => {
    confirmationTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation(next);
  };

  /** Clears the dialog and returns keyboard focus to the control that opened it, when it still exists. */
  const closeConfirmation = () => {
    setConfirmation(null);
    const trigger = confirmationTriggerRef.current;
    confirmationTriggerRef.current = null;
    if (!trigger) return;
    window.requestAnimationFrame(() => {
      if (document.contains(trigger)) trigger.focus();
    });
  };

  const confirmRevoke = () => openConfirmation({
    title: 'Revoke this participant preview?',
    description: 'The preview link stops working immediately and the participant can no longer open it. '
      + 'The link cannot be recovered — you would need to generate a new preview to share this project again.',
    confirmLabel: 'Revoke preview',
    run: handleRevoke,
  });

  const confirmCancelReminder = (reference: string) => openConfirmation({
    title: 'Cancel this scheduled reminder?',
    description: 'The scheduled reminder email will not be sent. The participant preview link itself is not affected, '
      + 'and you can schedule a new reminder afterwards.',
    confirmLabel: 'Cancel reminder',
    run: () => handleCancelReminder(reference),
  });

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
  const renderGenerateActions = (isCorrectionReissue: boolean, primaryLabel: string) => {
    if (!canManage) return null;
    return (
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
            <span className="text-sm text-muted-foreground">
              No participant contact email is recorded for this project, so the link cannot be emailed.
            </span>
          )}
          {!emailDeliveryEnabled && (
            <span className="text-sm text-muted-foreground">
              Email delivery is not enabled in this environment.
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 text-sm">
      {!canManage && (
        <p className="text-sm text-muted-foreground">
          You can view participant confirmation status, but you do not have permission to manage preview links or reminders.
        </p>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-sm font-medium leading-relaxed text-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {deliveryNotice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-success/40 bg-success/8 p-3 text-sm font-medium leading-relaxed text-foreground"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <span>{deliveryNotice}</span>
        </div>
      )}

      {reminderNotice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-success/40 bg-success/8 p-3 text-sm font-medium leading-relaxed text-foreground"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <span>{reminderNotice}</span>
        </div>
      )}

      {justGeneratedUrl && (
        <div className="space-y-2.5 rounded-lg border border-success/40 bg-success/8 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            <span>Preview link generated</span>
          </div>
          <p className="text-sm text-muted-foreground">
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
            {canManage && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={confirmRevoke}
                disabled={pending}
              >
                {pending ? 'Revoking…' : 'Revoke preview'}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <dl className="space-y-2">
              <div>
                <dt className="text-muted-foreground font-medium">Created</dt>
                <dd className="font-semibold text-foreground mt-0.5">
                  {formatParticipantPreviewDate(activePreview.createdAt)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">Expires</dt>
                <dd className="font-semibold text-foreground mt-0.5">
                  {formatParticipantPreviewDate(activePreview.expiresAt)}
                </dd>
              </div>
            </dl>

            <div className="space-y-2">
              <span className="text-muted-foreground font-medium block">Participant response</span>
              <div role="status">
                {previewResponseState.type === 'confirmed' ? (
                  <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/8 p-2.5 text-sm font-semibold text-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                    <span>Participant confirmed on {formatParticipantPreviewDate(previewResponseState.confirmedAt)}</span>
                  </div>
                ) : previewResponseState.type === 'correction_requested' ? (
                  <div className="space-y-2 rounded-md border border-warning/40 bg-warning/8 p-3 text-sm text-foreground">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <AlertCircle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                      <span>Correction requested on {formatParticipantPreviewDate(previewResponseState.requestedAt)}</span>
                    </div>
                    <div className="text-foreground bg-background p-2 rounded border border-border font-normal whitespace-pre-wrap">
                      {previewResponseState.comment}
                    </div>
                    <p>Review the complete participant correction package below. Begin review only after the project team submits it.</p>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">Not yet responded by the participant.</span>
                )}
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-border space-y-2" role="status">
            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">Email delivery</h4>
            {notification ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm bg-muted/40 p-3 rounded-md border border-border">
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <span className="font-semibold text-foreground">{participantPreviewNotificationStatusLabel(notification.status)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Recipient: </span>
                  <span className="font-semibold text-foreground">{notification.recipient}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Requested: </span>
                  <span className="text-foreground">{formatParticipantPreviewDate(notification.requestedAt)}</span>
                </div>
                {notification.sentAt && (
                  <div>
                    <span className="text-muted-foreground">Sent at: </span>
                    <span className="text-foreground">{formatParticipantPreviewDate(notification.sentAt)}</span>
                  </div>
                )}
                {deliveryExplanation(notification.kind, notification.status, Boolean(justGeneratedUrl)) && (
                  <div
                    className={`mt-1 font-medium sm:col-span-2 ${notification.status === 'failed' ? 'text-destructive-strong' : 'text-warning-strong'}`}
                  >
                    {deliveryExplanation(notification.kind, notification.status, Boolean(justGeneratedUrl))}
                  </div>
                )}
                {notification.failureCode && (
                  <details className="sm:col-span-2 text-muted-foreground">
                    <summary className="cursor-pointer rounded-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">Technical details</summary>
                    <span className="mt-1 block font-mono text-foreground">{notification.failureCode}</span>
                  </details>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This preview was generated without email delivery. Its secure link is intentionally not
                stored and cannot be recovered for later sending — revoke it and generate a new preview
                to email a link.
              </p>
            )}
          </div>

          {canManage && (
            <div className="pt-3 border-t border-border space-y-2.5">
              <div>
                <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">Schedule reminder</h4>
                <p className="text-sm text-muted-foreground mt-0.5">
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
                    Must be before {formatParticipantPreviewDate(activePreview.expiresAt)}.
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {!reminderSchedulingEnabled
                    ? 'Reminder scheduling is not enabled in this environment.'
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
          )}
        </div>
      ) : isInProgress ? (
        /* CASE B: Correction in progress (Preview A revoked) */
        <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/8 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>Correction resolution in progress</span>
          </div>
          {resolutionStatus?.comment && (
            <div className="text-sm text-foreground bg-background p-2.5 rounded border border-border whitespace-pre-wrap">
              <strong className="text-foreground">Participant comment:</strong> {resolutionStatus.comment}
            </div>
          )}
          {projectStatus === 'changes_requested' ? (
            <p className="text-sm text-muted-foreground">
              The project is currently marked <strong className="font-semibold text-foreground">Changes requested</strong>. Review and accept the exact participant-authored package below, complete the normal technical and review checks, then re-approve before issuing a corrected preview.
            </p>
          ) : projectStatus === 'approved' && canResolveCorrection ? (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-success flex items-center gap-1.5">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <span>Project re-approved! You may now issue a corrected participant preview.</span>
              </p>
              {renderGenerateActions(true, 'Generate corrected participant preview')}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Correction resolution is active.
            </p>
          )}
        </div>
      ) : resolutionStatus?.status === 'resolved' ? (
        /* CASE C: Correction resolved historical info */
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/8 p-3 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            <span className="font-semibold text-foreground">Participant correction resolved</span>
            {resolutionStatus.resolvedAt && (
              <span className="text-xs text-muted-foreground">
                on {formatParticipantPreviewDate(resolutionStatus.resolvedAt)}
              </span>
            )}
          </div>
          {isApprovedEligible && renderGenerateActions(false, 'Generate participant preview')}
        </div>
      ) : isApprovedEligible ? (
        /* CASE D: Normal approved state, no active preview */
        canManage ? (
          renderGenerateActions(false, 'Generate participant preview')
        ) : (
          <p className="text-sm text-muted-foreground">
            No active participant preview link has been generated.
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
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
                  {canManage && reminder.status === 'scheduled' && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => confirmCancelReminder(reminder.reference)}
                      disabled={pending}
                      className="h-7 px-2.5 text-xs"
                    >
                      Cancel reminder
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground pt-1">
                  <div><span className="text-foreground font-medium">Scheduled for:</span> {formatParticipantPreviewDate(reminder.scheduledFor)}</div>
                  <div><span className="text-foreground font-medium">Email recipient at scheduling time:</span> {reminder.recipient}</div>
                  <div><span className="text-foreground font-medium">Scheduled by:</span> {reminder.scheduledBy}</div>
                  <div><span className="text-foreground font-medium">Preview expires:</span> {formatParticipantPreviewDate(reminder.previewExpiresAt)}</div>
                  {reminder.triggeredAt && <div><span className="text-foreground font-medium">Triggered:</span> {formatParticipantPreviewDate(reminder.triggeredAt)}</div>}
                  {reminder.cancelledAt && <div><span className="text-foreground font-medium">Cancelled:</span> {formatParticipantPreviewDate(reminder.cancelledAt)}</div>}
                  {reminder.skipReason && <div><span className="text-foreground font-medium">Skip reason:</span> {reminder.skipReason}</div>}
                  {reminder.delivery && (
                    <div className="sm:col-span-2">
                      <span className="text-foreground font-medium">Delivery:</span>{' '}
                      {participantPreviewNotificationStatusLabel(reminder.delivery.status)}
                      {reminder.delivery.sentAt ? ` on ${formatParticipantPreviewDate(reminder.delivery.sentAt)}` : ''}
                      {deliveryExplanation('reminder', reminder.delivery.status) && (
                        <span className="mt-1 block text-foreground">{deliveryExplanation('reminder', reminder.delivery.status)}</span>
                      )}
                      {reminder.delivery.failureCode && (
                        <details className="mt-1">
                          <summary className="cursor-pointer rounded-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">Technical details</summary>
                          <span className="mt-1 block font-mono">{reminder.delivery.failureCode}</span>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open) closeConfirmation(); }}>
        {confirmation && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirmation.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep as is</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const run = confirmation.run;
                  closeConfirmation();
                  void run();
                }}
              >
                {confirmation.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
