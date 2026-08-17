import * as React from 'react';
import { Badge, type BadgeProps } from '../ui/badge';
import { WorkflowStatus } from '../../domain/workflowStatus';

interface ProjectStatusBadgeProps {
  status: WorkflowStatus | string;
  className?: string;
}

/**
 * Human-readable labels for the existing workflow statuses. Shared so the status badge,
 * the status filter options, and active-filter tokens always read identically.
 * Presentation only: the underlying workflow status values are unchanged.
 */
export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  published: 'Published',
  archived: 'Archived',
  deleted: 'Deleted',
};

export function getWorkflowStatusLabel(status: WorkflowStatus | string): string {
  const normalized = (status || '').toLowerCase() as WorkflowStatus;
  return WORKFLOW_STATUS_LABELS[normalized] ?? (status ? status.replace(/_/g, ' ') : 'Unknown');
}

export function ProjectStatusBadge({ status, className }: ProjectStatusBadgeProps) {
  const normalizedStatus = (status || '').toLowerCase() as WorkflowStatus;

  let variant: BadgeProps['variant'] = 'neutral';

  switch (normalizedStatus) {
    case 'submitted':
      variant = 'information';
      break;
    case 'in_review':
    case 'changes_requested':
      variant = 'warning';
      break;
    case 'approved':
      variant = 'success';
      break;
    case 'published':
      variant = 'primary';
      break;
    case 'deleted':
      variant = 'destructive';
      break;
    case 'draft':
    case 'archived':
    default:
      variant = 'neutral';
      break;
  }

  const label = getWorkflowStatusLabel(status);

  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}
