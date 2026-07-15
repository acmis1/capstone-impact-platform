import { createSupabaseServerClient } from '../lib/supabase/server';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { AdminAuthError, AuthenticatedAdminContext, AdminRole } from './authTypes';
import { getPermissionsForRoles } from './permissions';

/**
 * Server-only helper that authenticates the user session and authorizes administrative privileges.
 * 
 * Flow:
 * 1. Resolves Supabase session via HTTP cookies.
 * 2. Fetches user metadata to check token validity.
 * 3. Uses administrative client to lookup user details and roles.
 * 4. Determines permissions from the loaded roles.
 */
export async function requireAdmin(): Promise<AuthenticatedAdminContext> {
  let user;
  try {
    const supabaseSession = await createSupabaseServerClient();
    const { data, error: sessionError } = await supabaseSession.auth.getUser();

    if (sessionError || !data?.user) {
      throw new AdminAuthError('UNAUTHENTICATED', 'No active session or session has expired.');
    }
    user = data.user;
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminAuthError('UNAUTHENTICATED', msg || 'No active session.');
  }

  const supabaseAdmin = createSupabaseAdminClient();

  // Query admin_users table for matching auth_user_id
  const { data: adminUser, error: adminError } = await supabaseAdmin
    .from('admin_users')
    .select('id, email, full_name')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (adminError) {
    throw new AdminAuthError('CONFIGURATION_FAILURE', `Admin lookup failed: ${adminError.message}`);
  }

  if (!adminUser) {
    throw new AdminAuthError('ADMIN_NOT_PROVISIONED', 'Administrator profile not provisioned for this authenticated identity.');
  }

  // Load user roles from user_roles table
  const { data: rolesData, error: rolesError } = await supabaseAdmin
    .from('user_roles')
    .select('role')
    .eq('user_id', adminUser.id);

  if (rolesError) {
    throw new AdminAuthError('CONFIGURATION_FAILURE', `Admin roles lookup failed: ${rolesError.message}`);
  }

  const roles = (rolesData || [])
    .map((r) => r.role as AdminRole)
    .filter((role): role is AdminRole => ['admin', 'reviewer', 'editor'].includes(role));

  if (roles.length === 0) {
    throw new AdminAuthError('PERMISSION_DENIED', 'Access denied: No administrative roles assigned.');
  }

  const permissions = getPermissionsForRoles(roles);

  return {
    authUserId: user.id,
    adminUserId: adminUser.id,
    email: adminUser.email,
    fullName: adminUser.full_name || '',
    roles,
    permissions,
  };
}
