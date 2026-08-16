'use client';

import React, { useActionState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { loginAction } from './actions';
import { AppMark } from '../../components/ui/app-mark';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Alert } from '../../components/ui/alert';
import { Card, CardContent } from '../../components/ui/card';

function LoginForm() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams
    ? searchParams.get('next') || searchParams.get('redirectTo') || '/admin'
    : '/admin';
  const urlError = searchParams ? searchParams.get('error') : null;
  const urlStatus = searchParams ? searchParams.get('status') : null;

  const [state, formAction, isPending] = useActionState(loginAction, null);

  const getUrlErrorMessage = (code: string | null) => {
    if (!code) return null;
    switch (code) {
      case 'SESSION_EXPIRED':
        return 'Session expired. Please click the invitation link again.';
      case 'VERIFICATION_FAILED':
        return 'The invitation link is invalid or has expired.';
      case 'INVALID_PARAMETERS':
      case 'MISSING_TOKEN_HASH':
      case 'MISSING_TYPE':
      case 'INVALID_TYPE':
        return 'The invitation link is misconfigured or incomplete.';
      default:
        return 'An authentication error occurred.';
    }
  };

  const getUrlStatusMessage = (code: string | null) => {
    if (!code) return null;
    switch (code) {
      case 'PASSWORD_SET':
        return 'Security credentials established successfully. Please sign in below.';
      default:
        return null;
    }
  };

  const displayError = state?.error || getUrlErrorMessage(urlError);
  const displayStatus = getUrlStatusMessage(urlStatus);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="redirectTo" value={redirectTo} />

      <div className="flex flex-col gap-1.5 text-left">
        <Label htmlFor="email" isRequired>
          Email
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="staff@rmit.edu.au"
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5 text-left">
        <Label htmlFor="password" isRequired>
          Password
        </Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          disabled={isPending}
        />
      </div>

      {displayError && (
        <Alert variant="destructive" description={displayError} />
      )}

      {displayStatus && (
        <Alert variant="success" description={displayStatus} />
      )}

      <Button
        type="submit"
        disabled={isPending}
        className="w-full font-semibold mt-2"
        size="lg"
      >
        {isPending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md flex flex-col items-center">
        {/* Brand Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <AppMark size="lg" className="mb-3" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Capstone Impact Platform
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Staff sign-in
          </p>
        </div>

        {/* Login Form Container Card */}
        <Card className="w-full border-border bg-card shadow-sm">
          <CardContent className="pt-6">
            <Suspense
              fallback={
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Loading form…
                </div>
              }
            >
              <LoginForm />
            </Suspense>

            <p className="mt-6 text-center text-xs text-muted-foreground leading-normal">
              Access is provided to authorised School staff.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
