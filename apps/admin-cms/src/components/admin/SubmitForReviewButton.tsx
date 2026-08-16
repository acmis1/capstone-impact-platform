'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectMetadataNavigation } from './ProjectMetadataNavigation';
import { canSubmitForReview } from './submitForReviewButtonState';
import { Button } from '../ui/button';
import { Alert } from '../ui/alert';
import { Send, CheckCircle2 } from 'lucide-react';

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
  const { dirty } = useProjectMetadataNavigation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const submitInFlightRef = useRef(false);

  const handleSubmit = async () => {
    // Unsaved metadata edits must never be silently submitted alongside the workflow transition:
    // the authoritative persisted metadata must exactly match what the user finished editing.
    if (submitInFlightRef.current || !canSubmitForReview(pending, success, dirty)) return;

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
        if (data.blockingReasons && data.blockingReasons.length > 0) {
          throw new Error(`Submission blocked: ${data.blockingReasons.join('; ')}`);
        }
        throw new Error('Project could not be submitted for review. Please try again.');
      }

      setSuccess(true);
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && err.message.startsWith('Submission blocked:')
        ? err.message
        : 'Project could not be submitted for review. Please try again.';
      setError(message);
    } finally {
      setPending(false);
      submitInFlightRef.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-2.5 text-xs sm:text-sm">
      {error && (
        <Alert
          variant="destructive"
          title="Submission Failed"
          description={error}
        />
      )}
      {success && (
        <div className="p-3 rounded-md bg-success/10 border border-success/30 text-success text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Submitted for review successfully.</span>
        </div>
      )}
      {dirty && !success && (
        <div className="p-3 rounded-md bg-warning/10 border border-warning/30 text-warning text-xs font-medium">
          Save or Cancel your metadata edits before submitting for review.
        </div>
      )}
      <div>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmitForReview(pending, success, dirty)}
          className="font-semibold"
        >
          <Send className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          {pending
            ? 'Submitting…'
            : currentStatus === 'changes_requested'
              ? 'Resubmit for review'
              : 'Submit for review'}
        </Button>
      </div>
    </div>
  );
}
