'use server';

import 'server-only';

import { redirect } from 'next/navigation';
import {
  RECOVERY_INVALID_CLEANUP_PATH,
} from '../../../auth/confirmationValidation';
import { validatePasswordUpdate } from '../../../auth/invitationValidation';
import {
  clearRecoveryContextCookie,
} from '../../../auth/recoveryContext';
import { getVerifiedPasswordRecoveryAccess } from '../../../auth/recoverySession';
import { createSupabaseServerClient } from '../../../lib/supabase/server';

export interface RecoveryPasswordUpdateInput {
  password?: unknown;
  confirmation?: unknown;
}

export async function resetPasswordAction(input: RecoveryPasswordUpdateInput) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input instanceof FormData ||
    typeof (input as { get?: unknown }).get === 'function' ||
    typeof input.password !== 'string' ||
    typeof input.confirmation !== 'string'
  ) {
    return { error: 'PASSWORD_EMPTY' };
  }

  const validation = validatePasswordUpdate({
    password: input.password,
    confirmation: input.confirmation,
  });
  if (!validation.isValid) {
    return { error: validation.error ?? 'PASSWORD_UPDATE_FAILED' };
  }

  let invalidContext = false;
  let updateSuccess = false;
  let actionError: string | null = null;
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>> | null = null;

  try {
    supabase = await createSupabaseServerClient();
    const access = await getVerifiedPasswordRecoveryAccess(supabase);
    if (!access) {
      invalidContext = true;
    } else {
      const { error: updateError } = await supabase.auth.updateUser({
        password: input.password,
      });
      if (updateError) {
        actionError = 'PASSWORD_UPDATE_FAILED';
      } else {
        const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
        if (signOutError) {
          actionError = 'SESSION_TERMINATION_FAILED';
        } else {
          try {
            await clearRecoveryContextCookie();
            updateSuccess = true;
          } catch {
            actionError = 'SESSION_TERMINATION_FAILED';
          }
        }
      }
    }
  } catch {
    actionError = 'PASSWORD_UPDATE_FAILED';
  }

  if (invalidContext) {
    let terminated = false;
    if (supabase) {
      try {
        const { error } = await supabase.auth.signOut({ scope: 'local' });
        terminated = error === null;
      } catch {
        terminated = false;
      }
    }
    if (terminated) {
      try {
        await clearRecoveryContextCookie();
      } catch {
        // The cleanup route repeats cookie cleanup after the Auth session is terminated.
      }
    }
    redirect(RECOVERY_INVALID_CLEANUP_PATH);
  }

  if (updateSuccess) {
    redirect('/login?status=PASSWORD_RESET');
  }

  return { error: actionError ?? 'PASSWORD_UPDATE_FAILED' };
}
