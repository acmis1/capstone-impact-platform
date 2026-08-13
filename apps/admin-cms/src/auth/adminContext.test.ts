import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { resolveAdminContextFromAuthUser } from './adminContext';
import { AdminAuthError } from './authTypes';

const AUTH_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_ID = '22222222-2222-2222-2222-222222222222';

function client(options: {
  profile?: { id: string; email: string; full_name: string | null } | null;
  roles?: unknown[];
  pendingProvisioning?: boolean;
  profileError?: boolean;
  rolesError?: boolean;
  provisioningError?: boolean;
} = {}): SupabaseClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.in = () => builder;
      builder.limit = async () => ({
        data: options.pendingProvisioning ? [{ id: 'pending-request' }] : [],
        error: options.provisioningError ? new Error('private provisioning failure') : null,
      });
      builder.eq = () => {
        if (table === 'admin_users') {
          builder.maybeSingle = async () => ({
            data: options.profile === undefined
              ? { id: ADMIN_ID, email: 'staff@example.test', full_name: 'Synthetic Staff' }
              : options.profile,
            error: options.profileError ? new Error('private profile failure') : null,
          });
          return builder;
        }
        if (table === 'staff_provisioning_requests') {
          return builder;
        }
        return Promise.resolve({
          data: (options.roles ?? ['admin']).map((role) => ({ role })),
          error: options.rolesError ? new Error('private role failure') : null,
        });
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('resolveAdminContextFromAuthUser', () => {
  it('returns the exact linked profile and Admin permission set', async () => {
    await expect(resolveAdminContextFromAuthUser(AUTH_ID, client())).resolves.toEqual({
      authUserId: AUTH_ID,
      adminUserId: ADMIN_ID,
      email: 'staff@example.test',
      fullName: 'Synthetic Staff',
      roles: ['admin'],
      permissions: [
        'projects.read',
        'projects.review',
        'projects.archive',
        'projects.edit',
        'projects.publish',
        'staff.manage',
      ],
    });
  });

  it('deduplicates recognized multi-roles and ignores unknown authority', async () => {
    const context = await resolveAdminContextFromAuthUser(
      AUTH_ID,
      client({ roles: ['editor', 'reviewer', 'editor', 'unknown'] }),
    );
    expect(context.roles).toEqual(['reviewer', 'editor']);
    expect(context.permissions).toEqual(['projects.read', 'projects.review', 'projects.edit']);
  });

  it('reports recognized roles in canonical order regardless of database row order', async () => {
    const ascending = await resolveAdminContextFromAuthUser(
      AUTH_ID,
      client({ roles: ['editor', 'reviewer'] }),
    );
    const descending = await resolveAdminContextFromAuthUser(
      AUTH_ID,
      client({ roles: ['reviewer', 'editor'] }),
    );
    expect(ascending.roles).toEqual(descending.roles);
    expect(ascending.permissions).toEqual(descending.permissions);
  });

  it('classifies an authenticated user without a staff profile', async () => {
    await expect(resolveAdminContextFromAuthUser(AUTH_ID, client({ profile: null }))).rejects.toMatchObject({
      type: 'ADMIN_NOT_PROVISIONED',
    } satisfies Partial<AdminAuthError>);
  });

  it('denies a staff profile whose invitation is still awaiting activation', async () => {
    await expect(
      resolveAdminContextFromAuthUser(AUTH_ID, client({ pendingProvisioning: true })),
    ).rejects.toMatchObject({
      type: 'STAFF_ACTIVATION_PENDING',
      message: 'Access denied.',
    } satisfies Partial<AdminAuthError>);
  });

  it('classifies a provisioned profile with no recognized role', async () => {
    await expect(resolveAdminContextFromAuthUser(AUTH_ID, client({ roles: [] }))).rejects.toMatchObject({
      type: 'PERMISSION_DENIED',
    } satisfies Partial<AdminAuthError>);
  });

  it.each([
    { profileError: true },
    { rolesError: true },
    { provisioningError: true },
  ])('bounds database lookup failures as configuration failures', async (options) => {
    await expect(resolveAdminContextFromAuthUser(AUTH_ID, client(options))).rejects.toMatchObject({
      type: 'CONFIGURATION_FAILURE',
      message: 'Authentication service unavailable.',
    } satisfies Partial<AdminAuthError>);
  });
});
