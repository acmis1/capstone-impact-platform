import React from 'react';
import { Badge, type BadgeProps } from '../ui/badge';

export interface ImportBatchStatusBadgeProps {
  status: string;
  className?: string;
}

export default function ImportBatchStatusBadge({ status, className }: ImportBatchStatusBadgeProps) {
  let label: string;
  let variant: NonNullable<BadgeProps['variant']> = 'neutral';

  switch (status) {
    case 'completed':
      label = 'Import complete';
      variant = 'success';
      break;
    case 'metadata_staged':
      label = 'Details imported';
      variant = 'information';
      break;
    case 'processing':
      label = 'Processing';
      variant = 'information';
      break;
    case 'failed':
      label = 'Import failed';
      variant = 'destructive';
      break;
    default:
      label = status
        ? status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        : 'Unknown';
      variant = 'neutral';
      break;
  }

  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}
