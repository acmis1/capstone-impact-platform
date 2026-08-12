import type { SupabaseClient } from '@supabase/supabase-js';
import { AdminAuthError, type AdminRole, type AuthenticatedAdminContext } from './authTypes';
import { getPermissionsForRoles } from './permissions';

const RECOGNIZED_ROLES = new Set<AdminRole>(['admin', 'reviewer', 'editor']);

function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && RECOGNIZED_ROLES.has(value as AdminRole);
}

/** Resolve the production staff profile and exact permission union for an authenticated Auth ID. */
export async function resolveAdminContextFromAuthUser(
  authUserId: string,
  supabaseAdmin: SupabaseClient,
): Promise<AuthenticatedAdminContext> {
  let adminUser: { id: string; email: string; full_name: string | null } | null;

  try {
    const { data, error } = await supabaseAdmin
      .from('admin_users')
      .select('id, email, full_name')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (error) throw error;
    adminUser = data;
  } catch {
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  if (!adminUser) {
    throw new AdminAuthError('ADMIN_NOT_PROVISIONED', 'Access denied.');
  }

  let roleRows: Array<{ role: unknown }>;
  try {
    const { data, error } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', adminUser.id);
    if (error) throw error;
    roleRows = data ?? [];
  } catch {
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  const roles = Array.from(new Set(roleRows.map(({ role }) => role).filter(isAdminRole)));
  if (roles.length === 0) {
    throw new AdminAuthError('PERMISSION_DENIED', 'Access denied.');
  }

  return {
    authUserId,
    adminUserId: adminUser.id,
    email: adminUser.email,
    fullName: adminUser.full_name ?? '',
    roles,
    permissions: getPermissionsForRoles(roles),
  };
}
