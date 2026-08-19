'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Alert } from '../../../components/ui/alert';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  isValidRecoveryEmail,
  normalizeRecoveryEmail,
} from '../../../auth/recoveryRequest';
import { createSupabaseBrowserClient } from '../../../lib/supabase/client';

const GENERIC_SUCCESS_MESSAGE =
  'If an account exists for that email address, a password reset link will be sent. Check your inbox and spam folder.';
const GENERIC_RETRY_MESSAGE =
  'The reset request could not be sent. Please try again later.';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [outcome, setOutcome] = useState<'idle' | 'success' | 'retry'>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const submissionLockRef = useRef(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submissionLockRef.current) return;

    submissionLockRef.current = true;
    setValidationError(null);
    setOutcome('idle');

    const normalizedEmail = normalizeRecoveryEmail(email);
    if (!isValidRecoveryEmail(normalizedEmail)) {
      setValidationError('Enter a valid email address.');
      submissionLockRef.current = false;
      return;
    }

    setIsPending(true);
    try {
      const supabase = createSupabaseBrowserClient();
      await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: `${window.location.origin}/auth/recovery/callback`,
      });
      setOutcome('success');
    } catch {
      setOutcome('retry');
    } finally {
      setIsPending(false);
      submissionLockRef.current = false;
    }
  };

  return (
    <div className="space-y-5">
      {outcome === 'success' ? (
        <Alert
          variant="success"
          title="Check your email"
          description={GENERIC_SUCCESS_MESSAGE}
        />
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5 text-left">
            <Label htmlFor="recovery-email" isRequired>
              Email
            </Label>
            <Input
              id="recovery-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setValidationError(null);
                if (outcome === 'retry') setOutcome('idle');
              }}
              disabled={isPending}
              isInvalid={Boolean(validationError)}
              aria-describedby={validationError ? 'recovery-email-error' : undefined}
            />
          </div>

          {validationError ? (
            <Alert
              id="recovery-email-error"
              variant="destructive"
              description={validationError}
            />
          ) : null}
          {outcome === 'retry' ? (
            <Alert variant="destructive" description={GENERIC_RETRY_MESSAGE} />
          ) : null}

          <Button type="submit" size="lg" className="w-full" disabled={isPending}>
            {isPending ? 'Sending reset link…' : 'Send reset link'}
          </Button>
        </form>
      )}

      {outcome === 'success' ? (
        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          Recovery requests are rate-limited. Wait before requesting another link.
        </p>
      ) : null}

      <Link
        href="/login"
        className="block rounded-sm text-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Back to sign in
      </Link>
    </div>
  );
}
