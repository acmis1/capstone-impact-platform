import type { AdminPermission } from '../../auth/authTypes';
import { canPerformReviewAction } from '../../auth/permissions';
import type { ReviewAction } from '../../workflow/projectWorkflow';

/**
 * Limits status-valid review transitions to controls the current staff member may perform.
 * Server-side authorization remains the final enforcement boundary.
 */
export function getPermittedReviewActions(
  statusAllowedActions: readonly ReviewAction[],
  permissions: AdminPermission[],
): ReviewAction[] {
  return statusAllowedActions.filter((action) => canPerformReviewAction(permissions, action));
}
