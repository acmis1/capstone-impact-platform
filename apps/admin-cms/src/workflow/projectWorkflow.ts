import { WorkflowStatus } from '../domain/workflowStatus';

export type ReviewAction = 'request_changes' | 'approve' | 'archive' | 'restore';

export type RestorableArchiveOrigin = 'submitted' | 'in_review' | 'approved' | 'published';

/**
 * Derives the non-public state an archived project may return to. Publication is deliberately
 * never a restore target: a formerly published project returns to approved and must pass through
 * the ordinary explicit publication workflow again.
 */
export function getArchiveRestoreTarget(status: unknown): WorkflowStatus | null {
  if (typeof status !== 'string') return null;
  const normalizedStatus = status.toLowerCase() as WorkflowStatus;

  switch (normalizedStatus) {
    case 'submitted':
    case 'in_review':
    case 'approved':
      return normalizedStatus;
    case 'published':
      return 'approved';
    default:
      return null;
  }
}

/**
 * Returns list of permitted administrative review actions for a given status.
 */
export function getAllowedReviewActions(status: WorkflowStatus): ReviewAction[] {
  const normalizedStatus = status ? (status.toLowerCase() as WorkflowStatus) : 'draft';

  switch (normalizedStatus) {
    case 'submitted':
    case 'in_review':
      return ['request_changes', 'approve', 'archive'];
    case 'changes_requested':
      return ['approve'];
    case 'approved':
      return ['request_changes', 'archive'];
    case 'archived':
      return ['restore'];
    default:
      return [];
  }
}

export interface TransitionResult {
  allowed: boolean;
  fromStatus: WorkflowStatus;
  toStatus?: WorkflowStatus;
  error?: string;
}

/**
 * Validates and calculates project status transition targets for a review action.
 */
export function applyReviewActionTransition(
  status: WorkflowStatus,
  action: ReviewAction,
  archivedFromStatus?: unknown,
): TransitionResult {
  const normalizedStatus = status ? (status.toLowerCase() as WorkflowStatus) : 'draft';
  const allowed = getAllowedReviewActions(normalizedStatus);

  if (!allowed.includes(action)) {
    return {
      allowed: false,
      fromStatus: normalizedStatus,
      error: `Action "${action}" is not allowed from workflow state "${status}".`
    };
  }

  let toStatus: WorkflowStatus;
  switch (action) {
    case 'request_changes':
      toStatus = 'changes_requested';
      break;
    case 'approve':
      toStatus = 'approved';
      break;
    case 'archive':
      toStatus = 'archived';
      break;
    case 'restore': {
      const restoreTarget = getArchiveRestoreTarget(archivedFromStatus);
      if (!restoreTarget) {
        return {
          allowed: false,
          fromStatus: normalizedStatus,
          error: 'Archived project provenance is missing or invalid.',
        };
      }
      toStatus = restoreTarget;
      break;
    }
    default:
      return {
        allowed: false,
        fromStatus: normalizedStatus,
        error: `Unknown action: "${action}"`
      };
  }

  return {
    allowed: true,
    fromStatus: normalizedStatus,
    toStatus
  };
}
