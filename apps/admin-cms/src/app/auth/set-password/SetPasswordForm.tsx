'use client';

import React, { useRef, useState, useTransition } from 'react';
import { setPasswordAction } from './actions';
import { resolvePasswordInputs, isRedirectError } from './passwordSubmission';

export function SetPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const submissionLockRef = useRef(false);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (submissionLockRef.current) {
      return;
    }

    submissionLockRef.current = true;
    setError(null);

    const domPassword = passwordRef.current?.value || '';
    const domConfirmation = confirmationRef.current?.value || '';

    const resolved = resolvePasswordInputs({
      domPassword,
      domConfirmation,
      statePassword: password,
      stateConfirmation: confirmation,
    });

    startTransition(async () => {
      try {
        const res = await setPasswordAction({
          password: resolved.password,
          confirmation: resolved.confirmation,
        });

        if (res?.error) {
          setError(res.error);
          submissionLockRef.current = false;
        }
      } catch (err: unknown) {
        if (isRedirectError(err)) {
          throw err;
        }
        setError('PASSWORD_UPDATE_FAILED');
        submissionLockRef.current = false;
      }
    });
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (error) setError(null);
  };

  const handleConfirmationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmation(e.target.value);
    if (error) setError(null);
  };

  const hasPasswordError = !!error && (error === 'PASSWORD_TOO_SHORT' || error === 'PASSWORD_TOO_LONG' || error === 'PASSWORD_EMPTY');
  const hasConfirmationError = !!error && (error === 'CONFIRMATION_MISMATCH');

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label htmlFor="password" style={{ fontSize: '0.85rem', fontWeight: 600, color: '#9CA3AF' }}>
          New Password
        </label>
        <input
          ref={passwordRef}
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          placeholder="At least 12 characters"
          minLength={12}
          maxLength={128}
          value={password}
          onChange={handlePasswordChange}
          aria-invalid={hasPasswordError ? 'true' : 'false'}
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
          ref={confirmationRef}
          id="confirmation"
          name="confirmation"
          type="password"
          required
          autoComplete="new-password"
          placeholder="At least 12 characters"
          minLength={12}
          maxLength={128}
          value={confirmation}
          onChange={handleConfirmationChange}
          aria-invalid={hasConfirmationError ? 'true' : 'false'}
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

      {error && (
        <div
          aria-live="polite"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            color: '#F87171',
            padding: '0.75rem',
            borderRadius: '6px',
            fontSize: '0.85rem',
            textAlign: 'center',
          }}
        >
          {error === 'CONFIRMATION_MISMATCH' && 'Passwords do not match.'}
          {error === 'PASSWORD_TOO_SHORT' && 'Password must be at least 12 characters.'}
          {error === 'PASSWORD_TOO_LONG' && 'Password is too long.'}
          {error === 'PASSWORD_EMPTY' && 'Password cannot be empty.'}
          {error === 'UNAUTHENTICATED' && 'Session expired. Please request a new invitation.'}
          {error === 'SESSION_TERMINATION_FAILED' && 'Failed to terminate the invitation session.'}
          {error === 'PASSWORD_UPDATE_FAILED' && 'Failed to update password.'}
          {error !== 'CONFIRMATION_MISMATCH' &&
           error !== 'PASSWORD_TOO_SHORT' &&
           error !== 'PASSWORD_TOO_LONG' &&
           error !== 'PASSWORD_EMPTY' &&
           error !== 'UNAUTHENTICATED' &&
           error !== 'SESSION_TERMINATION_FAILED' &&
           error !== 'PASSWORD_UPDATE_FAILED' &&
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
