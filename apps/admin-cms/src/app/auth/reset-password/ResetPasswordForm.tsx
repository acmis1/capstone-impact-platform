'use client';

import { useRef, useState, useTransition } from 'react';
import { Alert } from '../../../components/ui/alert';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { resolvePasswordInputs, isRedirectError } from '../set-password/passwordSubmission';
import { resetPasswordAction } from './actions';

export function ResetPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const submissionLockRef = useRef(false);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submissionLockRef.current) return;

    submissionLockRef.current = true;
    setError(null);
    const resolved = resolvePasswordInputs({
      domPassword: passwordRef.current?.value ?? '',
      domConfirmation: confirmationRef.current?.value ?? '',
      statePassword: password,
      stateConfirmation: confirmation,
    });

    startTransition(async () => {
      try {
        const result = await resetPasswordAction(resolved);
        if (result?.error) {
          setError(result.error);
          submissionLockRef.current = false;
        }
      } catch (reason) {
        if (isRedirectError(reason)) throw reason;
        setError('PASSWORD_UPDATE_FAILED');
        submissionLockRef.current = false;
      }
    });
  };

  const errorMessage = (() => {
    switch (error) {
      case 'PASSWORD_EMPTY':
        return 'Enter a new password.';
      case 'PASSWORD_TOO_SHORT':
        return 'Password must be at least 12 characters.';
      case 'PASSWORD_TOO_LONG':
        return 'Password must be no more than 128 characters.';
      case 'CONFIRMATION_MISMATCH':
        return 'Passwords do not match.';
      case 'SESSION_TERMINATION_FAILED':
        return 'Your password changed, but the recovery session could not be closed. Try again.';
      case 'PASSWORD_COMPROMISED':
        return 'This password has appeared in a known data breach. Choose a different password.';
      case 'PASSWORD_UPDATE_FAILED':
        return 'The password could not be updated. Please try again.';
      default:
        return error ? 'The password reset could not be completed.' : null;
    }
  })();

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 text-left">
        <Label htmlFor="recovery-password" isRequired>
          New password
        </Label>
        <Input
          ref={passwordRef}
          id="recovery-password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          disabled={isPending}
          isInvalid={Boolean(error && error !== 'CONFIRMATION_MISMATCH')}
        />
      </div>

      <div className="flex flex-col gap-1.5 text-left">
        <Label htmlFor="recovery-confirmation" isRequired>
          Confirm new password
        </Label>
        <Input
          ref={confirmationRef}
          id="recovery-confirmation"
          name="confirmation"
          type="password"
          required
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value);
            setError(null);
          }}
          disabled={isPending}
          isInvalid={error === 'CONFIRMATION_MISMATCH'}
        />
      </div>

      {errorMessage ? <Alert variant="destructive" description={errorMessage} /> : null}

      <Button type="submit" size="lg" className="w-full" disabled={isPending}>
        {isPending ? 'Updating password…' : 'Reset password'}
      </Button>
    </form>
  );
}
