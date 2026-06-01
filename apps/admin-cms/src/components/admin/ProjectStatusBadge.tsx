import React from 'react';

interface ProjectStatusBadgeProps {
  status: string;
}

export function ProjectStatusBadge({ status }: ProjectStatusBadgeProps) {
  let backgroundColor = 'rgba(156, 163, 175, 0.1)';
  let color = '#9CA3AF';
  let borderColor = 'rgba(156, 163, 175, 0.2)';

  switch (status.toLowerCase()) {
    case 'draft':
      backgroundColor = 'rgba(156, 163, 175, 0.1)';
      color = '#9CA3AF';
      borderColor = 'rgba(156, 163, 175, 0.2)';
      break;
    case 'submitted':
      backgroundColor = 'rgba(59, 130, 246, 0.1)';
      color = '#3B82F6';
      borderColor = 'rgba(59, 130, 246, 0.2)';
      break;
    case 'in_review':
      backgroundColor = 'rgba(245, 158, 11 0.1)';
      color = '#F59E0B';
      borderColor = 'rgba(245, 158, 11, 0.2)';
      break;
    case 'changes_requested':
      backgroundColor = 'rgba(239, 68, 68, 0.1)';
      color = '#EF4444';
      borderColor = 'rgba(239, 68, 68, 0.2)';
      break;
    case 'approved':
      backgroundColor = 'rgba(16, 185, 129, 0.1)';
      color = '#10B981';
      borderColor = 'rgba(16, 185, 129, 0.2)';
      break;
    case 'published':
      backgroundColor = 'rgba(139, 92, 246, 0.1)';
      color = '#8B5CF6';
      borderColor = 'rgba(139, 92, 246, 0.2)';
      break;
    case 'archived':
      backgroundColor = 'rgba(107, 114, 128, 0.2)';
      color = '#9CA3AF';
      borderColor = 'rgba(107, 114, 128, 0.3)';
      break;
    case 'deleted':
      backgroundColor = 'rgba(220, 38, 38, 0.2)';
      color = '#F87171';
      borderColor = 'rgba(220, 38, 38, 0.3)';
      break;
  }

  return (
    <span style={{
      display: 'inline-block',
      padding: '0.25rem 0.6rem',
      borderRadius: '6px',
      fontSize: '0.75rem',
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      backgroundColor,
      color,
      border: `1px solid ${borderColor}`,
    }}>
      {status.replace('_', ' ')}
    </span>
  );
}
