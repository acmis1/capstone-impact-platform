import type { BulkReviewDisposition, BulkReviewOutcome } from '../../projects/bulkProjectReview';
import { WORKFLOW_STATUSES, type WorkflowStatus } from '../../domain/workflowStatus';
import { getWorkflowStatusLabel } from '../admin/ProjectStatusBadge';

/**
 * Staff-readable labels for bulk review results. The backend disposition and outcome tokens are
 * unchanged; only their presentation is translated. Underscore replacement is deliberately not
 * used as a fallback, because it leaks raw tokens such as `invalid_or_stale` into normal copy.
 */

const DISPOSITION_LABELS: Record<BulkReviewDisposition, string> = {
  eligible: 'Ready',
  blocked: 'Blocked',
  already_complete: 'Already complete',
  invalid_or_stale: 'Needs refresh or cannot continue',
};

const OUTCOME_LABELS: Record<BulkReviewOutcome, string> = {
  successful: 'Completed',
  blocked: 'Blocked',
  already_complete: 'Already complete',
  invalid_or_stale: 'Needs refresh or cannot continue',
  failed: 'Did not complete',
};

/** Safe generic label for a value this build has no human wording for. */
export const UNKNOWN_RESULT_LABEL = 'Result unavailable';

export function bulkDispositionLabel(value: string): string {
  return DISPOSITION_LABELS[value as BulkReviewDisposition] ?? UNKNOWN_RESULT_LABEL;
}

export function bulkOutcomeLabel(value: string): string {
  return OUTCOME_LABELS[value as BulkReviewOutcome] ?? UNKNOWN_RESULT_LABEL;
}

export function bulkStatusLabel(value: string | null): string {
  const normalized = (value || '').toLowerCase() as WorkflowStatus;
  if (!WORKFLOW_STATUSES.includes(normalized)) return 'Status unavailable';
  return getWorkflowStatusLabel(normalized);
}
