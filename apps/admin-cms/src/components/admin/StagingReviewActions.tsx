'use client';

import React, { useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Alert } from '../ui/alert';
import { CheckCircle2 } from 'lucide-react';

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
      <div className="text-xs text-muted-foreground italic">
        No administrative review actions are allowed from current status &quot;{currentStatus}&quot;.
      </div>
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

  const getActionButtonVariant = (action: string): 'default' | 'destructive' | 'outline' | 'secondary' => {
    if (action === 'approve') return 'default';
    if (action === 'request_changes') return 'destructive';
    if (action === 'archive') return 'secondary';
    return 'outline';
  };

  const formatActionLabel = (action: string) => {
    if (action === 'approve') return 'Approve project';
    if (action === 'request_changes') return 'Request changes';
    if (action === 'archive') return 'Archive project';
    return action.replace('_', ' ');
  };

  return (
    <div className="flex flex-col gap-4 text-xs sm:text-sm">
      {/* Review Scope note */}
      <div className="p-3 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground leading-relaxed">
        <strong>Review scope:</strong> Standard review actions update the project lifecycle status in the test environment. Published projects require the controlled Local archive workflow. Hosted public feeds and external integrations remain disconnected.
      </div>

      {success && (
        <div className="p-3 rounded-md bg-success/10 border border-success/30 text-success text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Status transition successful. Refreshing project details…</span>
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
        <Label htmlFor="review-action-comments" className="text-xs font-medium text-foreground">
          Review comments:
        </Label>
        <Textarea
          id="review-action-comments"
          rows={3}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          placeholder="Add optional notes or instructions regarding this review decision…"
          disabled={loading || success}
          className="text-xs"
        />
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        {allowedActions.map((action) => (
          <Button
            key={action}
            type="button"
            variant={getActionButtonVariant(action)}
            size="sm"
            onClick={() => handleAction(action)}
            disabled={loading || success}
            className="font-semibold capitalize"
          >
            {formatActionLabel(action)}
          </Button>
        ))}
      </div>
    </div>
  );
}
