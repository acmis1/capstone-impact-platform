import 'server-only';

import { createSupabaseServerClient } from '../lib/supabase/server';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { AdminAuthError, AuthenticatedAdminContext, AdminRole } from './authTypes';
import { getPermissionsForRoles } from './permissions';
import { parseClaimsResult } from './claimsResult';

/**
 * Server-only helper that authenticates the user session and authorizes administrative privileges.
 * 
 * Flow:
 * A. Resolves Server session client (failures map to CONFIGURATION_FAILURE).
 * B. Triggers getClaims() and validates claims envelope (failures map to UNAUTHENTICATED or CONFIGURATION_FAILURE).
 * C. Queries database admin profile (failures map to CONFIGURATION_FAILURE).
 * D. Checks admin provisioning (failures map to ADMIN_NOT_PROVISIONED).
 * E. Verifies user roles and permissions (failures map to PERMISSION_DENIED).
 */
export async function requireAdmin(): Promise<AuthenticatedAdminContext> {
  let supabaseSession;
  
  // A. Server session client creation boundary
  try {
    supabaseSession = await createSupabaseServerClient();
  } catch {
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  let authUserId: string;

  // B & C. getClaims result validation & execution boundary
  try {
    const result = await supabaseSession.auth.getClaims();
    authUserId = parseClaimsResult(result);
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) throw err;
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  let adminUser;
  let rolesData;

  // D. Administrator database lookup boundary
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
  } catch {
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  // E. Verify linked administrator profile exists
  if (!adminUser) {
    throw new AdminAuthError('ADMIN_NOT_PROVISIONED', 'Access denied.');
  }

  // F. Load user roles boundary
  try {
    const supabaseAdmin = createSupabaseAdminClient();
    const { data: rData, error: rolesError } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', adminUser.id);

    if (rolesError) {
      throw new Error(rolesError.message);
    }
    rolesData = rData;
  } catch {
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  const roles = (rolesData || [])
    .map((r) => r.role as AdminRole)
    .filter((role): role is AdminRole => ['admin', 'reviewer', 'editor'].includes(role));

  // G. Check recognized roles
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
