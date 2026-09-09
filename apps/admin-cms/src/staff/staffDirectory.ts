import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminRole } from '../auth/authTypes';
import { canonicalizeRoles } from '../auth/permissions';
import type { StaffDirectoryEntry, StaffProvisioningIncident } from './staffProvisioningRepository';

interface AdminUserRow {
  id: unknown;
  email: unknown;
  full_name: unknown;
  lifecycle_status: unknown;
  lifecycle_version: unknown;
  lifecycle_updated_at: unknown;
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

interface LifecycleEventRow {
  target_admin_user_id: unknown;
  lifecycle_version: unknown;
  provider_status: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function lifecycleVersion(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('STAFF_DIRECTORY_READ_FAILED');
  return parsed;
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
  const [profiles, roles, provisioning, lifecycleEvents] = await Promise.all([
    client.from('admin_users').select(
      'id, email, full_name, lifecycle_status, lifecycle_version, lifecycle_updated_at',
    ),
    client.from('user_roles').select('user_id, role'),
    client
      .from('staff_provisioning_requests')
      .select('admin_user_id, normalized_email, full_name, requested_roles, status, failure_code, created_at'),
    client
      .from('staff_lifecycle_events')
      .select('target_admin_user_id, lifecycle_version, provider_status'),
  ]);

  if (profiles.error || roles.error || provisioning.error || lifecycleEvents.error) {
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
  const providerStatusByTargetVersion = new Map<string, string>();
  for (const row of (lifecycleEvents.data ?? []) as LifecycleEventRow[]) {
    const targetId = text(row.target_admin_user_id);
    const version = lifecycleVersion(row.lifecycle_version);
    if (targetId) providerStatusByTargetVersion.set(`${targetId}:${version}`, text(row.provider_status));
  }

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
    const version = lifecycleVersion(row.lifecycle_version);
    const lifecycleStatus = text(row.lifecycle_status);
    if (lifecycleStatus !== 'active' && lifecycleStatus !== 'deactivated') {
      throw new Error('STAFF_DIRECTORY_READ_FAILED');
    }
    const eventProviderStatus = providerStatusByTargetVersion.get(`${id}:${version}`);
    const providerSync = eventProviderStatus === 'pending'
      ? ('pending' as const)
      : eventProviderStatus === 'failed'
        ? ('attention_required' as const)
        : ('synchronized' as const);
    return {
      fullName: text(row.full_name),
      email,
      roles: canonicalizeRoles(rolesByUser.get(id) ?? []),
      status: lifecycleStatus === 'deactivated'
        ? ('deactivated' as const)
        : pendingByAdminId.has(id)
          ? ('pending_activation' as const)
          : ('active' as const),
      version,
      providerSync,
      lastChangedAt: optionalText(row.lifecycle_updated_at),
      requestedAt: requestedAtByEmail.get(email) ?? null,
    };
  });

  staff.sort((a, b) => a.email.localeCompare(b.email));

  const incidents: StaffProvisioningIncident[] = provisioningRows
    .filter((row) => ['compensating', 'failed', 'compensation_failed'].includes(text(row.status)))
    .map((row) => ({
      fullName: text(row.full_name),
      email: text(row.normalized_email),
      roles: canonicalizeRoles(Array.isArray(row.requested_roles) ? row.requested_roles : []),
      status: text(row.status) as 'compensating' | 'failed' | 'compensation_failed',
      failureCode: optionalText(row.failure_code),
      requestedAt: optionalText(row.created_at),
    }))
    .sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));

  return { staff, incidents };
}

/** Roles a provisioning form may offer, in the repository's canonical order. */
export const ASSIGNABLE_STAFF_ROLES: readonly AdminRole[] = ['admin', 'reviewer', 'editor'];
