'use client';

import React, { useState } from 'react';

interface StagingReviewActionsProps {
  publicId: string;
  currentStatus: string;
  allowedActions: string[];
}

export function StagingReviewActions({ publicId, currentStatus, allowedActions }: StagingReviewActionsProps) {
  const [comments, setComments] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (allowedActions.length === 0 || currentStatus.toLowerCase() === 'deleted') {
    return (
      <div style={{ color: '#9CA3AF', fontSize: '0.85rem', fontStyle: 'italic' }}>
        No administrative staging review actions are allowed from current status &quot;{currentStatus}&quot;.
      </div>
    );
  }

  const handleAction = async (action: string) => {
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await fetch(`/api/projects/${publicId}/review-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action,
          comments: comments.trim() || undefined
        })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Staging transition failed');
      }

      setSuccess(true);
      setComments('');
      // Reload page to retrieve updated status and audit rows
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred during status transition.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const getButtonStyles = (action: string) => {
    let backgroundColor = '#4B5563';
    if (action === 'approve') backgroundColor = '#10B981';
    if (action === 'request_changes') backgroundColor = '#EF4444';
    if (action === 'archive') backgroundColor = '#6B7280';

    return {
      backgroundColor,
      color: '#FFFFFF',
      border: 'none',
      padding: '0.5rem 1rem',
      borderRadius: '6px',
      cursor: 'pointer',
      fontWeight: 'bold',
      fontSize: '0.85rem',
      marginRight: '0.75rem',
      opacity: loading ? 0.6 : 1,
      transition: 'opacity 0.2s',
    };
  };

  return (
    <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
      
      {/* Disclaimer details */}
      <div style={{
        fontSize: '0.8rem',
        color: '#9CA3AF',
        backgroundColor: '#0F172A',
        borderRadius: '6px',
        padding: '0.5rem 0.75rem',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        marginBottom: '1rem',
        lineHeight: '1.4'
      }}>
        💡 <strong>Staging Action Scope:</strong> This controls staging transitions only. Real authentication is simulated, Duda is disconnected, and the JSON feed is not republished automatically.
      </div>

      {success && (
        <div style={{
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          color: '#10B981',
          border: '1px solid rgba(16, 185, 129, 0.2)',
          borderRadius: '6px',
          padding: '0.5rem 0.75rem',
          fontSize: '0.85rem',
          fontWeight: 'bold',
          marginBottom: '1rem'
        }}>
          ✅ Transition Successful! Reloading staging details...
        </div>
      )}

      {error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          color: '#EF4444',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '6px',
          padding: '0.5rem 0.75rem',
          fontSize: '0.85rem',
          fontWeight: 'bold',
          marginBottom: '1rem'
        }}>
          ❌ Error: {error}
        </div>
      )}

      {/* Comment Input */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', fontSize: '0.8rem', color: '#9CA3AF', marginBottom: '0.25rem' }}>
          Staging Action Comments / Audit Reason:
        </label>
        <textarea
          rows={3}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          placeholder="e.g. Approved layout configuration; Poster document satisfies schema criteria; Staging archival test"
          disabled={loading || success}
          style={{
            width: '100%',
            backgroundColor: '#0F172A',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '6px',
            color: '#FFFFFF',
            padding: '0.5rem',
            fontFamily: 'inherit',
            fontSize: '0.85rem',
            resize: 'vertical'
          }}
        />
      </div>

      {/* Button Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {allowedActions.map((action) => (
          <button
            key={action}
            onClick={() => handleAction(action)}
            disabled={loading || success}
            style={getButtonStyles(action)}
          >
            {action.replace('_', ' ').toUpperCase()}
          </button>
        ))}
      </div>

    </div>
  );
}
