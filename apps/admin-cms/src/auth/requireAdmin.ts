import 'server-only';

import { createSupabaseServerClient } from '../lib/supabase/server';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { AdminAuthError, AuthenticatedAdminContext, AdminRole } from './authTypes';
import { getPermissionsForRoles } from './permissions';
import { extractSubClaim } from './claims';

/**
 * Server-only helper that authenticates the user session and authorizes administrative privileges.
 * 
 * Flow:
 * 1. Resolves Supabase session via HTTP cookies and calls getClaims().
 * 2. Validates sub claim as authUserId.
 * 3. Uses administrative client to lookup user details and roles.
 * 4. Determines permissions from the loaded roles.
 */
export async function requireAdmin(): Promise<AuthenticatedAdminContext> {
  let authUserId: string;
  try {
    const supabaseSession = await createSupabaseServerClient();
    const claims = await supabaseSession.auth.getClaims();
    authUserId = extractSubClaim(claims);
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminAuthError('UNAUTHENTICATED', msg || 'No active session.');
  }

  let adminUser;
  let rolesData;

  try {
    const supabaseAdmin = createSupabaseAdminClient();

    // Query admin_users table for matching auth_user_id
    const { data, error: adminError } = await supabaseAdmin
      .from('admin_users')
      .select('id, email, full_name')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (adminError) {
      throw new Error(adminError.message);
    }
    adminUser = data;

    if (!adminUser) {
      throw new AdminAuthError('ADMIN_NOT_PROVISIONED', 'Access denied.');
    }

    // Load user roles from user_roles table
    const { data: rData, error: rolesError } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', adminUser.id);

    if (rolesError) {
      throw new Error(rolesError.message);
    }
    rolesData = rData;
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) throw err;
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  const roles = (rolesData || [])
    .map((r) => r.role as AdminRole)
    .filter((role): role is AdminRole => ['admin', 'reviewer', 'editor'].includes(role));

  if (roles.length === 0) {
    throw new AdminAuthError('PERMISSION_DENIED', 'Access denied.');
  }

  const permissions = getPermissionsForRoles(roles);

  return {
    authUserId,
    adminUserId: adminUser.id,
    email: adminUser.email,
    fullName: adminUser.full_name || '',
    roles,
    permissions,
  };
}
