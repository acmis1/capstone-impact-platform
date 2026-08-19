'use server';

import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  CONFIRMATION_TOKEN_MAX_LENGTH,
  RECOVERY_FAILURE_PATH,
  RECOVERY_PASSWORD_PATH,
  RECOVERY_TOKEN_COOKIE_NAME,
  RECOVERY_TOKEN_COOKIE_PATH,
} from '../../../../auth/confirmationValidation';
import { issueRecoveryContextCookie } from '../../../../auth/recoveryContext';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';

export async function acceptRecoveryAction() {
  const cookieStore = await cookies();
  const tokenCookie = cookieStore.get(RECOVERY_TOKEN_COOKIE_NAME);
  const token = tokenCookie?.value;

  if (tokenCookie) {
    cookieStore.delete({
      name: RECOVERY_TOKEN_COOKIE_NAME,
      path: RECOVERY_TOKEN_COOKIE_PATH,
    });
  }

  if (!token || typeof token !== 'string' || token.trim() === '') {
    redirect(RECOVERY_FAILURE_PATH);
  }

  const trimmedToken = token.trim();
  if (trimmedToken.length > CONFIRMATION_TOKEN_MAX_LENGTH) {
    redirect(RECOVERY_FAILURE_PATH);
  }

  let success = false;
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>> | null = null;

  try {
    supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.verifyOtp({
      type: 'recovery',
      token_hash: trimmedToken,
    });

    if (!error && data.user && data.session) {
      await issueRecoveryContextCookie(data.user.id);
      success = true;
    }
  } catch {
    success = false;
  }

  if (!success && supabase) {
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Best-effort cleanup of a partially established recovery session.
    }
  }

  redirect(success ? RECOVERY_PASSWORD_PATH : RECOVERY_FAILURE_PATH);
}
