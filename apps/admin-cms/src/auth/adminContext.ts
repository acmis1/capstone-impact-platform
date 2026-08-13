import type { SupabaseClient } from '@supabase/supabase-js';
import { AdminAuthError, type AuthenticatedAdminContext } from './authTypes';
import { canonicalizeRoles, getPermissionsForRoles } from './permissions';

/**
 * Lifecycle states in which a provisioned identity exists but is deliberately not yet usable.
 * A staff profile and its role rows are created when an invitation is finalized, so this check —
 * not the absence of a profile — is what keeps an invited-but-not-activated identity out of the
 * Admin/CMS, including during the intermediate session Supabase issues while accepting an invite.
 */
const NON_USABLE_PROVISIONING_STATUSES = ['pending_activation'];

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

  // Fail closed while an invitation is still awaiting the invitee's account setup.
  try {
    const { data, error } = await supabaseAdmin
      .from('staff_provisioning_requests')
      .select('id')
      .eq('admin_user_id', adminUser.id)
      .in('status', NON_USABLE_PROVISIONING_STATUSES)
      .limit(1);
    if (error) throw error;
    if ((data ?? []).length > 0) {
      throw new AdminAuthError('STAFF_ACTIVATION_PENDING', 'Access denied.');
    }
  } catch (error) {
    if (error instanceof AdminAuthError) throw error;
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
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

  // Canonical order, so resolved authority never depends on database row ordering.
  const roles = canonicalizeRoles(roleRows.map(({ role }) => role));
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
