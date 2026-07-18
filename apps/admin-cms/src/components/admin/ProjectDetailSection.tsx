import React from 'react';

interface ProjectDetailSectionProps {
  title: string;
  borderColor?: string;
  children: React.ReactNode;
}

export function ProjectDetailSection({ title, borderColor = 'rgba(255, 255, 255, 0.05)', children }: ProjectDetailSectionProps) {
  return (
    <div style={{
      backgroundColor: '#161F30',
      borderRadius: '12px',
      padding: '1.5rem',
      border: '1px solid rgba(255, 255, 255, 0.05)',
      borderLeft: `4px solid ${borderColor}`,
      marginBottom: '1.5rem',
    }}>
      <h3 style={{
        margin: '0 0 1rem 0',
        fontSize: '1.15rem',
        fontWeight: 'bold',
        color: '#FFFFFF',
        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
        paddingBottom: '0.5rem',
      }}>
        {title}
      </h3>
      {children}
    </div>
  );
}
