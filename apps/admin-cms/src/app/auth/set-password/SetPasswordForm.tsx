'use client';

import React, { useActionState } from 'react';
import { setPasswordAction } from './actions';

export function SetPasswordForm() {
  const [state, formAction, isPending] = useActionState(setPasswordAction, null);

  return (
    <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label htmlFor="password" style={{ fontSize: '0.85rem', fontWeight: 600, color: '#9CA3AF' }}>
          New Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          placeholder="••••••••••••"
          minLength={12}
          maxLength={128}
          style={{
            backgroundColor: '#1F2937',
            border: '1px solid #374151',
            borderRadius: '6px',
            color: '#F9FAFB',
            padding: '0.75rem',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color 0.2s',
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label htmlFor="confirmation" style={{ fontSize: '0.85rem', fontWeight: 600, color: '#9CA3AF' }}>
          Confirm New Password
        </label>
        <input
          id="confirmation"
          name="confirmation"
          type="password"
          required
          autoComplete="new-password"
          placeholder="••••••••••••"
          minLength={12}
          maxLength={128}
          style={{
            backgroundColor: '#1F2937',
            border: '1px solid #374151',
            borderRadius: '6px',
            color: '#F9FAFB',
            padding: '0.75rem',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color 0.2s',
          }}
        />
      </div>

      {state?.error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: '#F87171',
          padding: '0.75rem',
          borderRadius: '6px',
          fontSize: '0.85rem',
          textAlign: 'center',
        }}>
          {state.error === 'CONFIRMATION_MISMATCH' && 'Passwords do not match.'}
          {state.error === 'PASSWORD_TOO_SHORT' && 'Password must be at least 12 characters.'}
          {state.error === 'PASSWORD_TOO_LONG' && 'Password is too long.'}
          {state.error === 'PASSWORD_EMPTY' && 'Password cannot be empty.'}
          {state.error === 'UNAUTHENTICATED' && 'Session expired. Please request a new invitation.'}
          {state.error === 'SESSION_TERMINATION_FAILED' && 'Failed to terminate the invitation session.'}
          {state.error === 'PASSWORD_UPDATE_FAILED' && 'Failed to update password.'}
          {state.error !== 'CONFIRMATION_MISMATCH' && 
           state.error !== 'PASSWORD_TOO_SHORT' && 
           state.error !== 'PASSWORD_TOO_LONG' && 
           state.error !== 'PASSWORD_EMPTY' && 
           state.error !== 'UNAUTHENTICATED' && 
           state.error !== 'SESSION_TERMINATION_FAILED' &&
           state.error !== 'PASSWORD_UPDATE_FAILED' && 
           'An unexpected error occurred.'}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        style={{
          backgroundColor: '#E61E2A',
          color: '#FFFFFF',
          border: 'none',
          borderRadius: '6px',
          padding: '0.75rem',
          fontSize: '0.95rem',
          fontWeight: 700,
          cursor: isPending ? 'not-allowed' : 'pointer',
          opacity: isPending ? 0.7 : 1,
          transition: 'background-color 0.2s',
        }}
      >
        {isPending ? 'Updating Password...' : 'Establish Security Credentials'}
      </button>
    </form>
  );
}
