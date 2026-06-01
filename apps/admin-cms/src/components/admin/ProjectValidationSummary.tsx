import React from 'react';
import { Project } from '../../domain/project';
import { validateProjectForApproval } from '../../validation/projectValidation';

interface ProjectValidationSummaryProps {
  project: Project;
}

export function ProjectValidationSummary({ project }: ProjectValidationSummaryProps) {
  const validation = validateProjectForApproval(project);
  
  // Custom staging checks based on the prompts requirements
  const localErrors: string[] = [...validation.errors];
  const localWarnings: string[] = [...validation.warnings];

  // Check invalid layout template
  const allowedTemplates = ['poster_showcase', 'technical_detail', 'media_rich'];
  const templateId = project.layoutConfig?.templateId;
  if (templateId && !allowedTemplates.includes(templateId)) {
    localErrors.push(`[Layout] Invalid layout templateId "${templateId}". Supported: ${allowedTemplates.join(', ')}.`);
  }

  // Check accessibility text & poster text warnings specifically
  if (!project.posterText || project.posterText.trim() === '') {
    if (!localWarnings.some(w => w.includes('posterText') || w.includes('poster text'))) {
      localWarnings.push('[Quality Check] Missing OCR poster text index (posterText). Recommended for search indices.');
    }
  }

  const isEligible = project.status === 'approved' || project.status === 'published';
  const hasBlockingErrors = localErrors.length > 0;
  const showReadyMessage = isEligible && !hasBlockingErrors;

  return (
    <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
      {showReadyMessage && (
        <div style={{
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          border: '1px solid rgba(16, 185, 129, 0.2)',
          borderRadius: '8px',
          padding: '0.75rem 1rem',
          color: '#10B981',
          fontWeight: 'bold',
          marginBottom: '1rem',
          fontSize: '0.85rem'
        }}>
          ✅ READY FOR PUBLIC FEED: This project record is approved/published and has no blocking validation errors.
        </div>
      )}

      {!showReadyMessage && isEligible && hasBlockingErrors && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '8px',
          padding: '0.75rem 1rem',
          color: '#EF4444',
          fontWeight: 'bold',
          marginBottom: '1rem',
          fontSize: '0.85rem'
        }}>
          ❌ BLOCKED: Project has approved/published status but fails compliance due to blocking errors.
        </div>
      )}

      {/* Errors Section */}
      <div>
        <h4 style={{ margin: '0 0 0.5rem 0', color: '#EF4444', fontSize: '0.95rem' }}>
          Blocking Errors ({localErrors.length})
        </h4>
        {localErrors.length === 0 ? (
          <p style={{ margin: '0 0 1rem 0', color: '#9CA3AF', fontSize: '0.85rem' }}>No blocking errors found.</p>
        ) : (
          <ul style={{ margin: '0 0 1rem 0', paddingLeft: '1.25rem', color: '#F87171', fontSize: '0.85rem' }}>
            {localErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Warnings Section */}
      <div style={{ marginTop: '1rem' }}>
        <h4 style={{ margin: '0 0 0.5rem 0', color: '#F59E0B', fontSize: '0.95rem' }}>
          Compliance Warnings ({localWarnings.length})
        </h4>
        {localWarnings.length === 0 ? (
          <p style={{ margin: 0, color: '#9CA3AF', fontSize: '0.85rem' }}>No compliance warnings.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.25rem', color: '#FBBF24', fontSize: '0.85rem' }}>
            {localWarnings.map((warn, i) => (
              <li key={i}>{warn}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
