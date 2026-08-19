'use server';

import 'server-only';

import { redirect } from 'next/navigation';
import {
  RECOVERY_INVALID_CLEANUP_PATH,
} from '../../../auth/confirmationValidation';
import { validatePasswordUpdate } from '../../../auth/invitationValidation';
import {
  clearRecoveryContextCookie,
  readRecoveryContextCookie,
  verifyRecoveryContext,
} from '../../../auth/recoveryContext';
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

  let contextUserId: string | null = null;
  try {
    const token = await readRecoveryContextCookie();
    const context = verifyRecoveryContext(token);
    if (context.valid) contextUserId = context.payload.userId;
  } catch {
    contextUserId = null;
  }

  let invalidContext = contextUserId === null;
  let updateSuccess = false;
  let actionError: string | null = null;
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>> | null = null;

  if (!invalidContext) {
    try {
      supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user || data.user.id !== contextUserId) {
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
            await clearRecoveryContextCookie();
            updateSuccess = true;
          }
        }
      }
    } catch {
      actionError = 'PASSWORD_UPDATE_FAILED';
    }
  }

  if (invalidContext) {
    if (supabase) {
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        // Best-effort local session termination for an invalid recovery context.
      }
    }
    try {
      await clearRecoveryContextCookie();
    } catch {
      // The cleanup route repeats this bounded local cleanup.
    }
    redirect(RECOVERY_INVALID_CLEANUP_PATH);
  }

  if (updateSuccess) {
    redirect('/login?status=PASSWORD_RESET');
  }

  return { error: actionError ?? 'PASSWORD_UPDATE_FAILED' };
}
