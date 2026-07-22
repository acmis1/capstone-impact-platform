import React from 'react';

export default function ImportBatchStatusBadge({ status }: { status: string }) {
  let backgroundColor = '#4B5563';
  let color = '#FFFFFF';
  const label = status.toUpperCase();

  switch (status) {
    case 'completed':
      backgroundColor = 'rgba(16, 185, 129, 0.1)';
      color = '#10B981';
      break;
    case 'processing':
      backgroundColor = 'rgba(59, 130, 246, 0.1)';
      color = '#3B82F6';
      break;
    case 'failed':
      backgroundColor = 'rgba(239, 110, 110, 0.1)';
      color = '#EF4444';
      break;
  }

  return (
    <span style={{
      backgroundColor,
      color,
      padding: '0.25rem 0.6rem',
      borderRadius: '6px',
      fontSize: '0.8rem',
      fontWeight: 600,
      display: 'inline-block'
    }}>
      {label}
    </span>
  );
}
