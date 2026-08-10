'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectMetadataNavigation } from './ProjectMetadataNavigation';

interface SubmitForReviewButtonProps {
  batchId: string;
  publicId: string;
  currentStatus: string;
}

interface SubmitResponse {
  success: boolean;
  error?: string;
  submittedCount?: number;
  blockingReasons?: string[];
}

export function SubmitForReviewButton({ batchId, publicId, currentStatus }: SubmitForReviewButtonProps) {
  const router = useRouter();
  const { dirty, confirmDiscard } = useProjectMetadataNavigation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const submitInFlightRef = useRef(false);

  const handleSubmit = async () => {
    if (submitInFlightRef.current || pending) return;

    // Unsaved metadata edits must never be silently submitted alongside the workflow transition.
    if (dirty && !confirmDiscard()) {
      return;
    }

    submitInFlightRef.current = true;
    setPending(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await fetch(`/api/imports/${batchId}/submit-for-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPublicIds: [publicId] }),
      });

      const data: SubmitResponse = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));

      if (!response.ok || !data.success) {
        const reasons = data.blockingReasons && data.blockingReasons.length > 0
          ? ` (${data.blockingReasons.join('; ')})`
          : '';
        throw new Error(`${data.error || 'Submission failed.'}${reasons}`);
      }

      setSuccess(true);
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred while submitting for review.';
      setError(message);
    } finally {
      setPending(false);
      submitInFlightRef.current = false;
    }
  };

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
      {success && (
        <div style={{
          backgroundColor: 'rgba(16, 185, 129, 0.1)', color: '#10B981', border: '1px solid rgba(16, 185, 129, 0.2)',
          borderRadius: '6px', padding: '0.5rem 0.75rem', fontWeight: 'bold', marginBottom: '0.75rem',
        }}>
          ✅ Submitted for review.
        </div>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={pending || success}
        style={{
          backgroundColor: '#10B981',
          color: '#FFFFFF',
          border: 'none',
          padding: '0.5rem 1rem',
          borderRadius: '6px',
          cursor: pending || success ? 'not-allowed' : 'pointer',
          fontWeight: 'bold',
          fontSize: '0.85rem',
          opacity: pending || success ? 0.6 : 1,
        }}
      >
        {pending ? 'Submitting…' : currentStatus === 'changes_requested' ? 'Resubmit for review' : 'Submit for review'}
      </button>
    </div>
  );
}
