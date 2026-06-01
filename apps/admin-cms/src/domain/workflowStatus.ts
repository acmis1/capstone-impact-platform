export type WorkflowStatus =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'published'
  | 'archived'
  | 'deleted';

export const WORKFLOW_STATUSES: WorkflowStatus[] = [
  'draft',
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'archived',
  'deleted',
];
