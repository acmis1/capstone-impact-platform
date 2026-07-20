'use server';

import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';

/**
 * Server Action that verifies the invitation token hash stored in the HttpOnly cookie.
 * 
 * Rules:
 * - Reads cookie server-side.
 * - Deletes the cookie immediately to prevent token reuse or replay.
 * - Revalidates parameters.
 * - Constructs Supabase client only after validation.
 * - Calls verifyOtp exactly once.
 * - Invokes redirect strictly outside try/catch blocks.
 * - Returns no secrets or PII.
 */
export async function acceptInvitationAction() {
  const cookieStore = await cookies();
  const tokenCookie = cookieStore.get('capstone_invitation_token_hash');
  const token = tokenCookie?.value;

  // Delete the cookie immediately on read attempt to ensure single-use
  if (tokenCookie) {
    cookieStore.delete({
      name: 'capstone_invitation_token_hash',
      path: '/auth/confirm',
    });
  }

  if (!token || typeof token !== 'string' || token.trim() === '') {
    redirect('/login?error=INVITATION_SESSION_MISSING');
  }

  const trimmedToken = token.trim();
  if (trimmedToken.length > 2048) {
    redirect('/login?error=TOKEN_TOO_LONG');
  }

  let verificationSuccess = false;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({
      type: 'invite',
      token_hash: trimmedToken,
    });

    if (!error) {
      verificationSuccess = true;
    }
  } catch {
    verificationSuccess = false;
  }

  // Redirect outcome based on OTP verification result
  if (verificationSuccess) {
    redirect('/auth/set-password');
  } else {
    redirect('/login?error=VERIFICATION_FAILED');
  }
}
