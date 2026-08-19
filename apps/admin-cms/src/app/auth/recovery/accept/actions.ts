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
import { parseClaimsResult } from '../../../../auth/claimsResult';
import { issueRecoveryContextCookie } from '../../../../auth/recoveryContext';
import {
  hasRecoveryAcceptanceProvenance,
  isSuccessfulRecoveryRegistration,
  registerPasswordRecoverySession,
} from '../../../../auth/recoverySession';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';
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
      const claims = parseClaimsResult(await supabase.auth.getClaims());
      if (claims.userId === data.user.id && hasRecoveryAcceptanceProvenance(claims)) {
        const registration = await registerPasswordRecoverySession(
          createSupabaseAdminClient(),
          claims,
        );
        if (isSuccessfulRecoveryRegistration(registration)) {
          await issueRecoveryContextCookie(claims.userId, claims.sessionId);
          success = true;
        }
      }
    }
  } catch {
    success = false;
  }

  if (!success && supabase) {
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) success = false;
    } catch {
      success = false;
    }
  }

  redirect(success ? RECOVERY_PASSWORD_PATH : RECOVERY_FAILURE_PATH);
}
