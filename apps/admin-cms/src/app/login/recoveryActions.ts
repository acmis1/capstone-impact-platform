'use server';

import 'server-only';

import { parseClaimsResult } from '../../auth/claimsResult';
import {
  clearRecoveryContextCookie,
  issueRecoveryContextCookie,
} from '../../auth/recoveryContext';
import {
  hasRecoveryAcceptanceProvenance,
  isSuccessfulRecoveryRegistration,
  registerPasswordRecoverySession,
} from '../../auth/recoverySession';
import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { createSupabaseServerClient } from '../../lib/supabase/server';

export interface FinalizeImplicitRecoveryResult {
  ok: boolean;
}

/**
 * Completes the hosted Supabase default-template implicit recovery handoff after
 * the browser has captured the provider-issued session from the URL fragment.
 *
 * This never trusts the fragment itself as recovery authority. The server repeats
 * the same verified claims, recovery-AMR, active-session and durable-ledger checks
 * used by the preferred token-hash/PKCE paths before issuing reset-form context.
 */
export async function finalizeImplicitRecoveryAction(): Promise<FinalizeImplicitRecoveryResult> {
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>> | null = null;

  try {
    supabase = await createSupabaseServerClient();
    const claims = parseClaimsResult(await supabase.auth.getClaims());

    if (!hasRecoveryAcceptanceProvenance(claims)) {
      throw new Error('Unsupported authentication provenance.');
    }

    const registration = await registerPasswordRecoverySession(
      createSupabaseAdminClient(),
      claims,
    );
    if (!isSuccessfulRecoveryRegistration(registration)) {
      throw new Error('Password recovery session registration failed.');
    }

    await issueRecoveryContextCookie(claims.userId, claims.sessionId);
    return { ok: true };
  } catch {
    if (supabase) {
      try {
        const { error } = await supabase.auth.signOut({ scope: 'local' });
        if (!error) {
          try {
            await clearRecoveryContextCookie();
          } catch {
            // The generic failure path remains closed even if cookie cleanup fails.
          }
        }
      } catch {
        // Recovery sessions never gain Admin access solely because cleanup failed.
      }
    }
    return { ok: false };
  }
}
