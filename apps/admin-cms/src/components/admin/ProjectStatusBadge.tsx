import * as React from 'react';
import { Badge, type BadgeProps } from '../ui/badge';
import { WorkflowStatus } from '../../domain/workflowStatus';

interface ProjectStatusBadgeProps {
  status: WorkflowStatus | string;
  className?: string;
}

export function ProjectStatusBadge({ status, className }: ProjectStatusBadgeProps) {
  const normalizedStatus = (status || '').toLowerCase() as WorkflowStatus;

  let variant: BadgeProps['variant'] = 'neutral';
  let label = status || 'Draft';

  switch (normalizedStatus) {
    case 'draft':
      variant = 'neutral';
      label = 'Draft';
      break;
    case 'submitted':
      variant = 'information';
      label = 'Submitted';
      break;
    case 'in_review':
      variant = 'warning';
      label = 'In review';
      break;
    case 'changes_requested':
      variant = 'warning';
      label = 'Changes requested';
      break;
    case 'approved':
      variant = 'success';
      label = 'Approved';
      break;
    case 'published':
      variant = 'primary';
      label = 'Published';
      break;
    case 'archived':
      variant = 'neutral';
      label = 'Archived';
      break;
    case 'deleted':
      variant = 'destructive';
      label = 'Deleted';
      break;
    default:
      variant = 'neutral';
      label = status ? status.replace(/_/g, ' ') : 'Unknown';
      break;
  }

  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}
