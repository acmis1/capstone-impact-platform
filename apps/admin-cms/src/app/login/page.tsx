'use client';

import React, { useActionState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { loginAction } from './actions';
import { AppMark } from '../../components/ui/app-mark';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Alert } from '../../components/ui/alert';
import { Card } from '../../components/ui/card';

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
      case 'RECOVERY_LINK_INVALID':
        return 'The password reset link is invalid or has expired. Request a new link.';
      default:
        return 'An authentication error occurred.';
    }
  };

  const getUrlStatusMessage = (code: string | null) => {
    if (!code) return null;
    switch (code) {
      case 'PASSWORD_SET':
        return 'Security credentials established successfully. Please sign in below.';
      case 'PASSWORD_RESET':
        return 'Your password has been reset. Sign in with your new password.';
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
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="password" isRequired>
            Password
          </Label>
          <Link
            href="/auth/forgot-password"
            className="rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Forgot password?
          </Link>
        </div>
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
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-between p-4 sm:p-6 lg:p-12">
      {/* Top subtle environment bar on mobile */}
      <div className="w-full max-w-5xl mx-auto flex items-center justify-between text-xs text-muted-foreground pb-4 lg:pb-0">
        <span className="font-medium tracking-tight">RMIT University</span>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-foreground">
          Staging Environment
        </span>
      </div>

      {/* Central Institutional Container */}
      <div className="w-full max-w-5xl mx-auto my-auto py-6 sm:py-8 lg:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
          {/* Left Column: Brand and Institutional Context */}
          <div className="lg:col-span-6 flex flex-col text-left space-y-4">
            <div className="flex items-center gap-3">
              <AppMark size="lg" />
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  School of Computing Technologies
                </span>
                <p className="text-xs font-medium text-primary">
                  Admin &amp; Editorial Operations
                </p>
              </div>
            </div>

            <div className="space-y-2 pt-2">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
                Capstone Impact Platform
              </h1>
              <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
                Institutional workspace for managing capstone project records, review workflows, and public showcase publication.
              </p>
            </div>

            {/* Value Pillars / Institutional Features */}
            <div className="hidden sm:grid grid-cols-1 gap-3 pt-2">
              <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/40 p-3">
                <div className="h-2 w-2 rounded-full bg-primary mt-1.5 shrink-0" aria-hidden="true" />
                <div className="text-xs">
                  <strong className="font-semibold text-foreground">Curated Project Directory:</strong>{' '}
                  <span className="text-muted-foreground">Batch import packages and reconcile project metadata.</span>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/40 p-3">
                <div className="h-2 w-2 rounded-full bg-secondary mt-1.5 shrink-0" aria-hidden="true" />
                <div className="text-xs">
                  <strong className="font-semibold text-foreground">Governed Editorial Review:</strong>{' '}
                  <span className="text-muted-foreground">Approve project media, preview layouts, and resolve corrections.</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Sign-in Form Card */}
          <div className="lg:col-span-6 w-full max-w-md mx-auto lg:max-w-none">
            <Card className="border border-border/80 bg-card shadow-sm rounded-xl">
              <div className="p-6 sm:p-8">
                <div className="space-y-1 text-left mb-6">
                  <h2 className="text-xl font-bold tracking-tight text-foreground">
                    Staff sign-in
                  </h2>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    Enter your authorized credentials to access your administrative workspace.
                  </p>
                </div>

                <Suspense
                  fallback={
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      Loading sign-in form…
                    </div>
                  }
                >
                  <LoginForm />
                </Suspense>

                <p className="mt-6 text-center text-xs text-muted-foreground leading-normal border-t border-border/60 pt-4">
                  Access is provided to authorised School staff.
                </p>
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* Bottom Institutional Footer */}
      <footer className="w-full max-w-5xl mx-auto pt-4 border-t border-border/40 text-center text-xs text-muted-foreground">
        <p>
          Capstone Impact Platform &copy; 2026 RMIT University. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
