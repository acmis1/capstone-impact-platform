'use client';

import React, { useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Alert } from '../ui/alert';
import { PROJECT_DETAIL_SURFACE_CLASSES } from './projectDetailSurfaceStyles';
import { CheckCircle2 } from 'lucide-react';
import { getReviewActionPresentation } from './reviewActionPresentation';

interface StagingReviewActionsProps {
  publicId: string;
  currentStatus: string;
  allowedActions: string[];
}

export function StagingReviewActions({ publicId, currentStatus, allowedActions }: StagingReviewActionsProps) {
  const [comments, setComments] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (allowedActions.length === 0 || currentStatus.toLowerCase() === 'deleted') {
    return (
      <p className="text-sm text-muted-foreground">
        No review transition is available from the current status.
      </p>
    );
  }

  const handleAction = async (action: string) => {
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await fetch(`/api/projects/${publicId}/review-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          comments: comments.trim() || undefined,
        }),
      });

      const data = await response.json().catch(() => ({ success: false }));

      if (!response.ok || !data.success) {
        throw new Error('Status transition could not be completed.');
      }

      setSuccess(true);
      setComments('');
      // Reload page to retrieve updated status and audit rows
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch {
      setError('Status transition could not be completed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      {success && (
        <div className={`flex items-start gap-2.5 p-3 ${PROJECT_DETAIL_SURFACE_CLASSES.affirm}`} role="status">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <span className="text-sm font-medium leading-relaxed">Status transition successful. Refreshing project details…</span>
        </div>
      )}

      {error && (
        <Alert
          variant="destructive"
          title="Review Action Failed"
          description={error}
        />
      )}

      {/* Review Comment Input */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="review-action-comments">Review comments</Label>
        <Textarea
          id="review-action-comments"
          rows={3}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          placeholder="Add optional notes or instructions regarding this review decision…"
          disabled={loading || success}
        />
      </div>

      {/* Action Buttons */}
      <div className="flex flex-col gap-2">
        {allowedActions.map((action) => {
          const presentation = getReviewActionPresentation(action);
          return (
            <Button
              key={action}
              type="button"
              variant={presentation.variant}
              onClick={() => handleAction(action)}
              disabled={loading || success}
              className={`w-full font-semibold ${presentation.className ?? ''}`}
            >
              {presentation.label}
            </Button>
          );
        })}
      </div>

      <p className={`p-3 text-sm leading-relaxed ${PROJECT_DETAIL_SURFACE_CLASSES.context}`}>
        <strong className="font-semibold text-foreground">Review scope:</strong> review actions update the
        project lifecycle status in the test environment. Published projects use the controlled local archive
        workflow. Hosted public feeds and external integrations remain disconnected.
      </p>
    </div>
  );
}
