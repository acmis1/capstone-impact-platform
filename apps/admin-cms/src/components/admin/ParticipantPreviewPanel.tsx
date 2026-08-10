'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ParticipantPreviewResponseState } from '../../domain/participantPreview';

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
}

interface GenerateResponse {
  success: boolean;
  error?: string;
  code?: string;
  previewUrl?: string;
  createdAt?: string;
  expiresAt?: string;
}

interface RevokeResponse {
  success: boolean;
  error?: string;
  revokedAt?: string;
}

export function ParticipantPreviewPanel({ publicId, canManage, isApprovedEligible, initialActivePreview, responseState }: ParticipantPreviewPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePreview, setActivePreview] = useState<ActivePreviewState | null>(initialActivePreview);
  const [previewResponseState, setPreviewResponseState] = useState<ParticipantPreviewResponseState>(responseState);
  const [justGeneratedUrl, setJustGeneratedUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inFlightRef = useRef(false);

  const handleGenerate = async () => {
    if (inFlightRef.current || pending) return;
    inFlightRef.current = true;
    setPending(true);
    setError(null);
    setCopyState('idle');

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/participant-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred while generating the preview.');
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
          <div className="mt-2 text-sm" role="status">
            {previewResponseState.type === 'confirmed' ? (
              <span className="font-semibold text-emerald-500">
                Participant confirmed on {new Date(previewResponseState.confirmedAt).toLocaleString()}
              </span>
            ) : previewResponseState.type === 'correction_requested' ? (
              <div className="font-semibold text-amber-500">
                <div>Correction requested on {new Date(previewResponseState.requestedAt).toLocaleString()}</div>
                <div className="mt-1 font-normal text-foreground" style={{ whiteSpace: 'pre-wrap' }}>
                  {previewResponseState.comment}
                </div>
              </div>
            ) : (
              <span className="italic text-muted-foreground">Not yet responded by the participant.</span>
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
      ) : isApprovedEligible ? (
        <button
          type="button"
          onClick={handleGenerate}
          disabled={pending}
          style={{
            backgroundColor: '#3B82F6', color: '#FFFFFF', border: 'none', padding: '0.5rem 1rem',
            borderRadius: '6px', cursor: pending ? 'not-allowed' : 'pointer', fontWeight: 'bold',
            fontSize: '0.85rem', opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? 'Generating…' : 'Generate participant preview'}
        </button>
      ) : (
        <div style={{ color: '#9CA3AF', fontStyle: 'italic' }}>
          Available once the project reaches the approved state.
        </div>
      )}
    </div>
  );
}
