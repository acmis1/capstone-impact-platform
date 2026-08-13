'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ParticipantPreviewResponseState, ParticipantPreviewCorrectionResolutionStatus } from '../../domain/participantPreview';
import {
  participantPreviewNotificationStatusLabel,
  type ParticipantPreviewNotificationView,
} from '../../notifications/participantPreviewNotification';

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
  const inFlightRef = useRef(false);

  if (!stateAvailable) {
    return (
      <div role="status" style={{ fontSize: '0.85rem', color: '#D1D5DB' }}>
        <strong style={{ color: '#F59E0B' }}>Participant Preview status unavailable.</strong>
        <div style={{ marginTop: '0.35rem', color: '#9CA3AF' }}>
          Preview actions are temporarily disabled because the current preview state could not be verified.
        </div>
      </div>
    );
  }

  if (!resolutionStateAvailable) {
    return (
      <div role="status" style={{ fontSize: '0.85rem', color: '#D1D5DB' }}>
        <strong style={{ color: '#F59E0B' }}>Correction-resolution status unavailable.</strong>
        <div style={{ marginTop: '0.35rem', color: '#9CA3AF' }}>
          Preview and correction-resolution actions are temporarily disabled until authoritative state can be verified.
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

  if (!canManage) {
    return (
      <div style={{ fontSize: '0.85rem', color: '#9CA3AF', fontStyle: 'italic' }}>
        You do not have permission to generate or revoke participant preview links.
      </div>
    );
  }

  // Determine current resolution state if any
  const resStatus = resolutionStatus?.status;
  const isInProgress = resStatus === 'in_progress' || (projectStatus === 'changes_requested' && resolutionStatus?.status === 'in_progress');

  const canSendEmail = emailDeliveryEnabled && Boolean(participantContactEmail);

  /**
   * Generate + Send is offered only alongside generation, never as a later action on an existing
   * preview: the secure link is deliberately not stored, so there is nothing left to send once the
   * request that created it has finished.
   */
  const renderGenerateActions = (isCorrectionReissue: boolean, primaryLabel: string, primaryColor: string) => (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => handleGenerate(isCorrectionReissue, false)}
        disabled={pending}
        style={{
          backgroundColor: primaryColor, color: '#FFFFFF', border: 'none', padding: '0.5rem 1rem',
          borderRadius: '6px', cursor: pending ? 'not-allowed' : 'pointer', fontWeight: 'bold',
          fontSize: '0.85rem', opacity: pending ? 0.6 : 1,
        }}
      >
        {pending ? 'Working…' : primaryLabel}
      </button>
      {canSendEmail && (
        <button
          type="button"
          onClick={() => handleGenerate(isCorrectionReissue, true)}
          disabled={pending}
          style={{
            backgroundColor: '#0F766E', color: '#FFFFFF', border: 'none', padding: '0.5rem 1rem',
            borderRadius: '6px', cursor: pending ? 'not-allowed' : 'pointer', fontWeight: 'bold',
            fontSize: '0.85rem', opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? 'Working…' : `${primaryLabel} and send email`}
        </button>
      )}
      {emailDeliveryEnabled && participantContactEmail && (
        <span style={{ color: '#9CA3AF', fontSize: '0.78rem' }}>
          Email would be sent to <strong style={{ color: '#D1D5DB' }}>{participantContactEmail}</strong>
        </span>
      )}
      {emailDeliveryEnabled && !participantContactEmail && (
        <span style={{ color: '#9CA3AF', fontSize: '0.78rem', fontStyle: 'italic' }}>
          No participant contact email is recorded for this project, so the link cannot be emailed.
        </span>
      )}
      {!emailDeliveryEnabled && (
        <span style={{ color: '#9CA3AF', fontSize: '0.78rem', fontStyle: 'italic' }}>
          Email delivery is not enabled on this server.
        </span>
      )}
    </div>
  );

  return (
    <div style={{ fontSize: '0.85rem' }}>
      {error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '6px', padding: '0.5rem 0.75rem', fontWeight: 'bold', marginBottom: '0.75rem',
        }}>
          ❌ {error}
        </div>
      )}

      {deliveryNotice && (
        <div
          role="status"
          style={{
            backgroundColor: 'rgba(13, 148, 136, 0.08)', border: '1px solid rgba(13, 148, 136, 0.3)',
            borderRadius: '8px', padding: '0.6rem 0.9rem', marginBottom: '0.75rem', color: '#5EEAD4',
          }}
        >
          {deliveryNotice}
        </div>
      )}

      {justGeneratedUrl && (
        <div style={{
          backgroundColor: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)',
          borderRadius: '8px', padding: '0.85rem 1rem', marginBottom: '1rem',
        }}>
          <div style={{ color: '#10B981', fontWeight: 'bold', marginBottom: '0.4rem' }}>
            ✅ Preview link generated
          </div>
          <div style={{ color: '#F59E0B', fontSize: '0.78rem', marginBottom: '0.5rem' }}>
            This is the only time the full link is shown. It cannot be recovered later — copy it now.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{
              backgroundColor: '#1E293B', padding: '0.35rem 0.6rem', borderRadius: '4px', color: '#93C5FD',
              wordBreak: 'break-all', fontSize: '0.78rem', flex: '1 1 320px',
            }}>
              {justGeneratedUrl}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              style={{
                backgroundColor: '#3B82F6', color: '#FFFFFF', border: 'none', padding: '0.4rem 0.8rem',
                borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.78rem',
              }}
            >
              {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* CASE A: Active preview exists */}
      {activePreview ? (
        <div style={{
          backgroundColor: 'rgba(59, 130, 246, 0.06)', border: '1px solid rgba(59, 130, 246, 0.2)',
          borderRadius: '8px', padding: '0.85rem 1rem',
        }}>
          <div style={{ color: '#60A5FA', fontWeight: 'bold', marginBottom: '0.4rem' }}>Active preview</div>
          <div style={{ color: '#D1D5DB', fontSize: '0.8rem' }}>
            <div>Created: {activePreview.createdAt ? new Date(activePreview.createdAt).toLocaleString() : 'N/A'}</div>
            <div>Expires: {activePreview.expiresAt ? new Date(activePreview.expiresAt).toLocaleString() : 'N/A'}</div>
          </div>
          <div style={{ marginTop: '0.6rem', fontSize: '0.8rem' }} role="status">
            {notification ? (
              <div style={{ color: '#D1D5DB' }}>
                <div>
                  <strong style={{ color: '#93C5FD' }}>Email delivery:</strong>{' '}
                  {participantPreviewNotificationStatusLabel(notification.status)}
                </div>
                <div>Sent to: {notification.recipient}</div>
                <div>Requested: {new Date(notification.requestedAt).toLocaleString()}</div>
                {notification.sentAt && <div>Delivered: {new Date(notification.sentAt).toLocaleString()}</div>}
                {notification.failureCode && <div>Reason: {notification.failureCode}</div>}
                {notification.status === 'delivery_unknown' && (
                  <div style={{ color: '#F59E0B', marginTop: '0.25rem' }}>
                    The message may or may not have reached the participant. It has not been sent again
                    automatically. Revoke this preview and issue a new one if you need to be certain.
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: '#9CA3AF', fontStyle: 'italic' }}>
                This preview was generated without email delivery. Its secure link is intentionally not
                stored and cannot be recovered for later sending — revoke it and generate a new preview
                to email a link.
              </div>
            )}
          </div>
          <div className="mt-2 text-sm" role="status">
            {previewResponseState.type === 'confirmed' ? (
              <span className="font-semibold text-emerald-500" style={{ color: '#10B981', fontWeight: 'bold' }}>
                Participant confirmed on {new Date(previewResponseState.confirmedAt).toLocaleString()}
              </span>
            ) : previewResponseState.type === 'correction_requested' ? (
              <div className="font-semibold text-amber-500" style={{ color: '#F59E0B', fontWeight: 'bold' }}>
                <div>Correction requested on {new Date(previewResponseState.requestedAt).toLocaleString()}</div>
                <div style={{ marginTop: '0.25rem', color: '#D1D5DB', fontWeight: 'normal', whiteSpace: 'pre-wrap' }}>
                  {previewResponseState.comment}
                </div>
                {canResolveCorrection && (
                  <button
                    type="button"
                    onClick={handleStartResolution}
                    disabled={pending}
                    style={{
                      marginTop: '0.6rem', backgroundColor: '#F59E0B', color: '#000000', border: 'none',
                      padding: '0.4rem 0.8rem', borderRadius: '6px', cursor: pending ? 'not-allowed' : 'pointer',
                      fontWeight: 'bold', fontSize: '0.8rem', opacity: pending ? 0.6 : 1, display: 'block',
                    }}
                  >
                    {pending ? 'Starting resolution…' : 'Start correction resolution'}
                  </button>
                )}
              </div>
            ) : (
              <span style={{ color: '#9CA3AF', fontStyle: 'italic' }}>Not yet responded by the participant.</span>
            )}
          </div>
          <button
            type="button"
            onClick={handleRevoke}
            disabled={pending}
            style={{
              marginTop: '0.6rem', backgroundColor: '#EF4444', color: '#FFFFFF', border: 'none',
              padding: '0.4rem 0.8rem', borderRadius: '6px', cursor: pending ? 'not-allowed' : 'pointer',
              fontWeight: 'bold', fontSize: '0.8rem', opacity: pending ? 0.6 : 1,
            }}
          >
            {pending ? 'Revoking…' : 'Revoke preview'}
          </button>
        </div>
      ) : isInProgress ? (
        /* CASE B: Correction in progress (Preview A revoked) */
        <div style={{
          backgroundColor: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.25)',
          borderRadius: '8px', padding: '0.85rem 1rem',
        }}>
          <div style={{ color: '#F59E0B', fontWeight: 'bold', marginBottom: '0.4rem' }}>
            🛠️ Correction resolution in progress
          </div>
          {resolutionStatus?.comment && (
            <div style={{ color: '#D1D5DB', fontSize: '0.8rem', marginBottom: '0.5rem', whiteSpace: 'pre-wrap' }}>
              <strong>Participant comment:</strong> {resolutionStatus.comment}
            </div>
          )}
          {projectStatus === 'changes_requested' ? (
            <div style={{ color: '#9CA3AF', fontSize: '0.8rem', fontStyle: 'italic' }}>
              Project is currently in <code>changes_requested</code>. Update project metadata below, then use the review actions to re-approve the project before issuing a corrected preview.
            </div>
          ) : projectStatus === 'approved' && canResolveCorrection ? (
            <div>
              <div style={{ color: '#10B981', fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                Project re-approved! You may now issue a corrected participant preview.
              </div>
              {renderGenerateActions(true, 'Generate corrected participant preview', '#10B981')}
            </div>
          ) : (
            <div style={{ color: '#9CA3AF', fontSize: '0.8rem', fontStyle: 'italic' }}>
              Correction resolution is active.
            </div>
          )}
        </div>
      ) : resolutionStatus?.status === 'resolved' ? (
        /* CASE C: Correction resolved historical info */
        <div>
          <div style={{
            backgroundColor: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.15)',
            borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem', color: '#D1D5DB', fontSize: '0.8rem',
          }}>
            <span style={{ color: '#10B981', fontWeight: 'bold' }}>✓ Participant correction resolved</span>
            {resolutionStatus.resolvedAt && (
              <span style={{ color: '#9CA3AF', marginLeft: '0.5rem' }}>
                on {new Date(resolutionStatus.resolvedAt).toLocaleString()}
              </span>
            )}
          </div>
          {isApprovedEligible && renderGenerateActions(false, 'Generate participant preview', '#3B82F6')}
        </div>
      ) : isApprovedEligible ? (
        /* CASE D: Normal approved state, no active preview */
        renderGenerateActions(false, 'Generate participant preview', '#3B82F6')
      ) : (
        <div style={{ color: '#9CA3AF', fontStyle: 'italic' }}>
          Available once the project reaches the approved state.
        </div>
      )}
    </div>
  );
}
