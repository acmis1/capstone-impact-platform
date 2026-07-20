'use server';

import 'server-only';

import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { validatePasswordUpdate } from '../../../auth/invitationValidation';

/**
 * Server Action to set/update a user's password during the invitation flow.
 * 
 * Rules:
 * - Requires a valid authenticated session.
 * - Validates input using the pure validation module.
 * - Updates the password using supabase.auth.updateUser.
 * - Signs the user out immediately on success to prevent session reuse.
 * - Never logs or exposes raw password values.
 * - Never writes to database tables (admin_users/user_roles).
 */
export async function setPasswordAction(prevState: unknown, formData: FormData) {
  const password = formData.get('password') as string;
  const confirmation = formData.get('confirmation') as string;

  const validation = validatePasswordUpdate({ password, confirmation });
  if (!validation.isValid || !validation.data) {
    return { error: validation.error || 'PASSWORD_VALIDATION_FAILED' };
  }

  const validatedPassword = validation.data;

  try {
    const supabase = await createSupabaseServerClient();

    // Verify current user session exists
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return { error: 'UNAUTHENTICATED' };
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: validatedPassword
    });

    if (updateError) {
      return { error: 'PASSWORD_UPDATE_FAILED' };
    }

    // Force sign out immediately after successful update
    await supabase.auth.signOut();
  } catch {
    return { error: 'PASSWORD_UPDATE_FAILED' };
  }

  // Redirect to login page on success with a safe status indicator
  return { success: true };
}
