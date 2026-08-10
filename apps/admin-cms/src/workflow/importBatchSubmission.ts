import { WorkflowStatus } from '../domain/workflowStatus';

export type SubmissionEligibility = 'eligible' | 'already_submitted' | 'ineligible';

/**
 * Determines whether a project's current workflow status may be submitted for review.
 * Mirrors the source-of-truth transition rules enforced inside
 * submit_import_projects_for_review: draft/changes_requested are eligible,
 * submitted is treated as already satisfied (idempotent no-op), everything else is rejected.
 */
export function getSubmissionEligibility(status: WorkflowStatus | string): SubmissionEligibility {
  const normalized = (status ? status.toLowerCase() : 'draft') as WorkflowStatus;

  if (normalized === 'draft' || normalized === 'changes_requested') {
    return 'eligible';
  }
  if (normalized === 'submitted') {
    return 'already_submitted';
  }
  return 'ineligible';
}
