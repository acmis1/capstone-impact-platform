'use server';

import { createSupabaseServerClient } from '../../lib/supabase/server';
import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { redirect } from 'next/navigation';

/**
 * Server Action to authenticate administrative users.
 * 
 * Rules:
 * - Uses cookie-based client for password verification.
 * - Confirms profile provisioning against admin_users schema before granting access.
 * - Signs out and rejects authenticated identities that are not provisioned as admins.
 * - Sanitizes return-path redirects to prevent open redirection.
 */
export async function loginAction(prevState: unknown, formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const redirectTo = formData.get('redirectTo') as string;

  if (!email || !password) {
    return { error: 'Please enter both email and password.' };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data?.user) {
      return { error: 'Invalid email or password.' };
    }

    // Authenticated! Verify public admin profile exists
    const supabaseAdmin = createSupabaseAdminClient();
    const { data: adminUser, error: dbError } = await supabaseAdmin
      .from('admin_users')
      .select('id')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();

    if (dbError || !adminUser) {
      // Identity not provisioned in database admin list. Sign out immediately.
      await supabase.auth.signOut();
      return { error: 'Access denied. This account is not provisioned as an administrator.' };
    }
  } catch {
    return { error: 'An unexpected authentication error occurred.' };
  }

  // Sanitize redirect target path
  const target = redirectTo && redirectTo.startsWith('/') && !redirectTo.startsWith('//')
    ? redirectTo
    : '/admin';

  redirect(target);
}

/**
 * Server Action to sign out and clear session cookies.
 */
export async function logoutAction() {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch {
    // Ignore sign-out error
  }
  redirect('/login');
}
