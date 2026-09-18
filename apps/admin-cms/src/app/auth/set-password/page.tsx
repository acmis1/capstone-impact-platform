import React from 'react';
import { AuthPageShell } from '../../../components/auth/AuthPageShell';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { SetPasswordForm } from './SetPasswordForm';

export const dynamic = 'force-dynamic';

/**
 * Server component representing the protected Set Password page.
 * 
 * Rules:
 * - Requires a valid authenticated Supabase session.
 * - Redirects unauthenticated requests to /login immediately.
 * - Restricts access server-side before rendering the credential form.
 * - Never renders user identity details or other PII in HTML.
 */
export default async function SetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login?error=SESSION_EXPIRED');
  }

  return (
    <AuthPageShell title="Set up your password" description="Set a password for your invited School staff account." footer="Password setup ends this session. Sign in with your new password afterward.">
      <SetPasswordForm />
    </AuthPageShell>
  );
}
