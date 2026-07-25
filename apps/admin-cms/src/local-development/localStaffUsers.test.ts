import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  provisionLocalStaffUsers,
  SYNTHETIC_STAFF_DEFINITIONS,
  loadOrGenerateLocalCredentials,
} from './localStaffUsers';

describe('Local Staff Provisioning Security & Logic Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');

  it('1. Exactly three synthetic staff definitions exist with correct role mapping', () => {
    expect(SYNTHETIC_STAFF_DEFINITIONS.length).toBe(3);
    const roles = SYNTHETIC_STAFF_DEFINITIONS.map((d) => d.role);
    expect(roles).toEqual(['admin', 'reviewer', 'editor']);
  });

  it('2. Reject tracked repository path for custom credentials output', async () => {
    const trackedPath = path.resolve(repoRoot, 'apps/admin-cms/src/tracked-users.json');
    await expect(
      provisionLocalStaffUsers({
        credentialsOutputPath: trackedPath,
        supabaseUrl: 'http://127.0.0.1:54321',
        serviceRoleKey: 'test-key',
      })
    ).rejects.toThrow('Invalid output path');
  });

  it('3. Accept OS temporary directory for custom credentials output', () => {
    const tmpPath = path.resolve(os.tmpdir(), 'test-creds.json');
    const creds = loadOrGenerateLocalCredentials(tmpPath);
    expect(Object.keys(creds).length).toBe(3);
  });

  it('4. Reject non-loopback Supabase URL with generic error without exposing URL', async () => {
    const sensitiveUrl = 'https://abcdefghijkl.supabase.co';
    const tmpPath = path.resolve(os.tmpdir(), 'test-creds-2.json');
    try {
      await provisionLocalStaffUsers({
        credentialsOutputPath: tmpPath,
        supabaseUrl: sensitiveUrl,
        serviceRoleKey: 'secret-key-12345',
      });
      expect.fail('Should have thrown error');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toBe('Non-loopback Supabase endpoint rejected.');
      expect(msg).not.toContain(sensitiveUrl);
      expect(msg).not.toContain('secret-key-12345');
      expect(msg).not.toContain('abcdefghijkl');
    }
  });

  it('5. Provisioning works deterministically with a mocked Supabase administrative client boundary', async () => {
    const tmpCredsPath = path.resolve(os.tmpdir(), `test-staff-${Date.now()}.json`);

    const mockUserRoles: Array<{ user_id: string; role: string }> = [];
    const mockAuthUsers: Array<{ id: string; email: string }> = [];

    const mockClient = {
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({ data: { users: mockAuthUsers }, error: null }),
          createUser: vi.fn().mockImplementation(async (params: { email: string }) => {
            const newUser = { id: `auth-${params.email}`, email: params.email };
            mockAuthUsers.push(newUser);
            return { data: { user: newUser }, error: null };
          }),
          updateUserById: vi.fn().mockResolvedValue({ data: { user: {} }, error: null }),
        },
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'admin_users') {
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockImplementation(async () => {
                  return { data: { id: `profile-${Date.now()}` }, error: null };
                }),
              }),
            }),
          };
        }
        if (table === 'user_roles') {
          return {
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
            insert: vi.fn().mockImplementation(async (row: { user_id: string; role: string }) => {
              mockUserRoles.push(row);
              return { error: null };
            }),
          };
        }
        return {};
      }),
    };

    const res = await provisionLocalStaffUsers({
      credentialsOutputPath: tmpCredsPath,
      customClient: mockClient as unknown as import('@supabase/supabase-js').SupabaseClient,
    });

    expect(res.provisionedRoles.length).toBe(3);
    expect(mockUserRoles.length).toBe(3);
  });
});
