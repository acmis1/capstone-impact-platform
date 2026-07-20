'use server';

import 'server-only';

import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { validatePasswordUpdate } from '../../../auth/invitationValidation';
import { redirect } from 'next/navigation';

/**
 * Server Action to set/update a user's password during the invitation flow.
 * 
 * Rules:
 * - Validates input using the pure validation module before constructing client.
 * - Requires a valid authenticated session via getUser.
 * - Updates the password using supabase.auth.updateUser.
 * - Signs the user out immediately via local scope on success.
 * - Inspects sign-out error and fails on error.
 * - Invokes redirect strictly outside the try/catch block.
 * - Never logs or exposes raw password values or user identity.
 */
export async function setPasswordAction(prevState: unknown, formData: FormData) {
  const rawPassword = formData.get('password');
  const rawConfirmation = formData.get('confirmation');

  const password = typeof rawPassword === 'string' ? rawPassword : '';
  const confirmation = typeof rawConfirmation === 'string' ? rawConfirmation : '';

  // 1. Validate before constructing the Supabase client
  const validation = validatePasswordUpdate({ password, confirmation });
  if (!validation.isValid) {
    return { error: validation.error || 'PASSWORD_VALIDATION_FAILED' };
  }

  let updateSuccess = false;
  let actionError: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();

    // 2. Require an authenticated user
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      actionError = 'UNAUTHENTICATED';
    } else {
      // 3. Call updateUser exactly once
      const { error: updateError } = await supabase.auth.updateUser({
        password: password
      });

      if (updateError) {
        actionError = 'PASSWORD_UPDATE_FAILED';
      } else {
        // 4. Call signOut with local scope
        const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
        if (signOutError) {
          actionError = 'SESSION_TERMINATION_FAILED';
        } else {
          updateSuccess = true;
        }
      }
    }
  } catch {
    actionError = 'PASSWORD_UPDATE_FAILED';
  }

  // 5. Invoke redirect strictly outside the try/catch block
  if (updateSuccess) {
    redirect('/login?status=PASSWORD_SET');
  }

  return { error: actionError || 'PASSWORD_UPDATE_FAILED' };
}
