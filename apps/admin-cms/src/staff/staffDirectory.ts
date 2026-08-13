import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminRole } from '../auth/authTypes';
import { canonicalizeRoles } from '../auth/permissions';
import type { StaffDirectoryEntry, StaffProvisioningIncident } from './staffProvisioningRepository';

interface AdminUserRow {
  id: unknown;
  email: unknown;
  full_name: unknown;
}

interface RoleRow {
  user_id: unknown;
  role: unknown;
}

interface ProvisioningRow {
  admin_user_id: unknown;
  normalized_email: unknown;
  full_name: unknown;
  requested_roles: unknown;
  status: unknown;
  failure_code: unknown;
  created_at: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Reads the bounded staff directory for the Admin/CMS management surface.
 *
 * Deliberately exposes no internal Auth UUIDs, no `admin_users` primary keys, no invitation
 * secrets and no provider detail — only the operational facts a staff manager needs. Roles pass
 * through the same canonicalization the authorization path uses, so the directory and the
 * resolved permission set can never disagree about which roles are recognized.
 */
export async function readStaffDirectory(
  client: SupabaseClient,
): Promise<{ staff: StaffDirectoryEntry[]; incidents: StaffProvisioningIncident[] }> {
  const [profiles, roles, provisioning] = await Promise.all([
    client.from('admin_users').select('id, email, full_name'),
    client.from('user_roles').select('user_id, role'),
    client
      .from('staff_provisioning_requests')
      .select('admin_user_id, normalized_email, full_name, requested_roles, status, failure_code, created_at'),
  ]);

  if (profiles.error || roles.error || provisioning.error) {
    throw new Error('STAFF_DIRECTORY_READ_FAILED');
  }

  const rolesByUser = new Map<string, unknown[]>();
  for (const row of (roles.data ?? []) as RoleRow[]) {
    const userId = text(row.user_id);
    if (!userId) continue;
    const bucket = rolesByUser.get(userId) ?? [];
    bucket.push(row.role);
    rolesByUser.set(userId, bucket);
  }

  const provisioningRows = (provisioning.data ?? []) as ProvisioningRow[];

  const pendingByAdminId = new Map<string, ProvisioningRow>();
  for (const row of provisioningRows) {
    if (text(row.status) !== 'pending_activation') continue;
    const adminUserId = text(row.admin_user_id);
    if (adminUserId) pendingByAdminId.set(adminUserId, row);
  }

  const requestedAtByEmail = new Map<string, string>();
  for (const row of provisioningRows) {
    const email = text(row.normalized_email);
    const createdAt = optionalText(row.created_at);
    if (email && createdAt && !requestedAtByEmail.has(email)) {
      requestedAtByEmail.set(email, createdAt);
    }
  }

  const staff: StaffDirectoryEntry[] = ((profiles.data ?? []) as AdminUserRow[]).map((row) => {
    const id = text(row.id);
    const email = text(row.email);
    return {
      fullName: text(row.full_name),
      email,
      roles: canonicalizeRoles(rolesByUser.get(id) ?? []),
      status: pendingByAdminId.has(id) ? ('pending_activation' as const) : ('active' as const),
      requestedAt: requestedAtByEmail.get(email) ?? null,
    };
  });

  staff.sort((a, b) => a.email.localeCompare(b.email));

  const incidents: StaffProvisioningIncident[] = provisioningRows
    .filter((row) => text(row.status) === 'failed' || text(row.status) === 'compensation_failed')
    .map((row) => ({
      fullName: text(row.full_name),
      email: text(row.normalized_email),
      roles: canonicalizeRoles(Array.isArray(row.requested_roles) ? row.requested_roles : []),
      status: text(row.status) as 'failed' | 'compensation_failed',
      failureCode: optionalText(row.failure_code),
      requestedAt: optionalText(row.created_at),
    }))
    .sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));

  return { staff, incidents };
}

/** Roles a provisioning form may offer, in the repository's canonical order. */
export const ASSIGNABLE_STAFF_ROLES: readonly AdminRole[] = ['admin', 'reviewer', 'editor'];
