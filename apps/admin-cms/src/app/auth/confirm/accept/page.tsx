import React from 'react';
import { AuthPageShell } from '../../../../components/auth/AuthPageShell';
import { Button } from '../../../../components/ui/button';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { acceptInvitationAction } from './actions';
import { INVITATION_COOKIE_NAME } from '../../../../auth/invitationValidation';

export const dynamic = 'force-dynamic';

/**
 * Server Component representing the explicit Acceptance Page.
 * 
 * Rules:
 * - Reads only the presence of the secure HttpOnly cookie.
 * - Redirects immediately to login if the cookie is missing.
 * - Performs no automatic execution, network checks, or token verification during render.
 * - Displays a generic security confirmation form.
 * - Renders zero token values or PII.
 */
export default async function AcceptInvitationPage() {
  const cookieStore = await cookies();
  const hasTokenCookie = cookieStore.has(INVITATION_COOKIE_NAME);

  if (!hasTokenCookie) {
    redirect('/login?error=INVITATION_SESSION_MISSING');
  }

  return (
    <AuthPageShell title="Confirm your invitation" description="Accept your invitation to the School administrative workspace. This verifies your email address and continues to password setup." footer="Continuing establishes a secure session for setting your credentials.">
      <form action={acceptInvitationAction}><Button type="submit" className="w-full">Accept invitation</Button></form>
    </AuthPageShell>
  );
}
