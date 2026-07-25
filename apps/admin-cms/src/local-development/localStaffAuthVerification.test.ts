import { describe, it, expect, vi } from 'vitest';
import {
  validateCredentialsStructure,
  verifySyntheticStaffAuthLogins,
} from './localStaffAuthVerification';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Local Staff Auth & Credential Pure Unit Tests', () => {
  const validCredsObj = {
    generatedAt: new Date().toISOString(),
    users: {
      'local.admin@capstone.test': 'Pass123!',
      'local.reviewer@capstone.test': 'Pass123!',
      'local.editor@capstone.test': 'Pass123!',
    },
  };

  it('1. validateCredentialsStructure accepts valid credentials object', () => {
    const creds = validateCredentialsStructure(validCredsObj);
    expect(Object.keys(creds).length).toBe(3);
    expect(creds['local.admin@capstone.test']).toBe('Pass123!');
  });

  it('2. validateCredentialsStructure rejects missing top-level users key', () => {
    expect(() => validateCredentialsStructure({})).toThrow(
      'Invalid credentials file: Missing or invalid top-level users object.'
    );
  });

  it('3. validateCredentialsStructure rejects unexpected credential entries', () => {
    const invalidObj = {
      users: {
        'local.admin@capstone.test': 'Pass123!',
        'local.reviewer@capstone.test': 'Pass123!',
        'local.editor@capstone.test': 'Pass123!',
        'unexpected@test.com': 'Hack123!',
      },
    };
    expect(() => validateCredentialsStructure(invalidObj)).toThrow(
      'Invalid credentials file: Unexpected credential keys count.'
    );
  });

  it('4. validateCredentialsStructure rejects missing password or non-string password', () => {
    const invalidObj = {
      users: {
        'local.admin@capstone.test': '',
        'local.reviewer@capstone.test': 'Pass123!',
        'local.editor@capstone.test': 'Pass123!',
      },
    };
    expect(() => validateCredentialsStructure(invalidObj)).toThrow(
      'Invalid credentials file: Non-empty password string required.'
    );
  });

  function createMockAuthClients(overrides: {
    failedRole?: 'admin' | 'reviewer' | 'editor';
    failedEmailMismatchRole?: string;
    failedProfileMismatchRole?: string;
    failedRoleMismatchRole?: string;
  } = {}) {
    const mockAnonClient = {
      auth: {
        signInWithPassword: vi.fn().mockImplementation(async (params: { email: string }) => {
          if (
            (params.email === 'local.admin@capstone.test' && overrides.failedRole === 'admin') ||
            (params.email === 'local.reviewer@capstone.test' && overrides.failedRole === 'reviewer') ||
            (params.email === 'local.editor@capstone.test' && overrides.failedRole === 'editor')
          ) {
            return { data: { user: null }, error: new Error('Invalid login credentials') };
          }

          const returnedEmail =
            overrides.failedEmailMismatchRole && params.email.includes(overrides.failedEmailMismatchRole)
              ? 'mismatch@capstone.test'
              : params.email;

          return {
            data: { user: { id: `auth-id-${params.email}`, email: returnedEmail } },
            error: null,
          };
        }),
      },
    } as unknown as SupabaseClient;

    const mockAdminClient = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'admin_users') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockImplementation(async () => {
                  if (overrides.failedProfileMismatchRole) {
                    return { data: null, error: new Error('Profile missing') };
                  }
                  return { data: { id: 'admin-profile-123' }, error: null };
                }),
              }),
            }),
          };
        }
        if (table === 'user_roles') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation(async () => {
                if (overrides.failedRoleMismatchRole) {
                  return { data: [{ role: 'editor' }], error: null };
                }
                return { data: [{ role: 'admin' }], error: null };
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient;

    return { mockAnonClient, mockAdminClient };
  }

  it('5. verifySyntheticStaffAuthLogins fails verification when admin login fails', async () => {
    const { mockAnonClient, mockAdminClient } = createMockAuthClients({ failedRole: 'admin' });
    const success = await verifySyntheticStaffAuthLogins(
      validCredsObj.users,
      () => mockAnonClient,
      mockAdminClient
    );
    expect(success).toBe(false);
  });

  it('6. verifySyntheticStaffAuthLogins fails verification when reviewer login fails', async () => {
    const { mockAnonClient, mockAdminClient } = createMockAuthClients({ failedRole: 'reviewer' });
    const success = await verifySyntheticStaffAuthLogins(
      validCredsObj.users,
      () => mockAnonClient,
      mockAdminClient
    );
    expect(success).toBe(false);
  });

  it('7. verifySyntheticStaffAuthLogins fails verification when editor login fails', async () => {
    const { mockAnonClient, mockAdminClient } = createMockAuthClients({ failedRole: 'editor' });
    const success = await verifySyntheticStaffAuthLogins(
      validCredsObj.users,
      () => mockAnonClient,
      mockAdminClient
    );
    expect(success).toBe(false);
  });

  it('8. verifySyntheticStaffAuthLogins fails verification on returned email mismatch', async () => {
    const { mockAnonClient, mockAdminClient } = createMockAuthClients({ failedEmailMismatchRole: 'admin' });
    const success = await verifySyntheticStaffAuthLogins(
      validCredsObj.users,
      () => mockAnonClient,
      mockAdminClient
    );
    expect(success).toBe(false);
  });

  it('9. verifySyntheticStaffAuthLogins fails verification on profile linkage mismatch', async () => {
    const { mockAnonClient, mockAdminClient } = createMockAuthClients({ failedProfileMismatchRole: 'admin' });
    const success = await verifySyntheticStaffAuthLogins(
      validCredsObj.users,
      () => mockAnonClient,
      mockAdminClient
    );
    expect(success).toBe(false);
  });

  it('10. Logged error outputs never contain passwords, sessions, or UUIDs', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { mockAnonClient, mockAdminClient } = createMockAuthClients({ failedRole: 'admin' });

    await verifySyntheticStaffAuthLogins(validCredsObj.users, () => mockAnonClient, mockAdminClient);

    expect(consoleSpy).toHaveBeenCalled();
    const loggedOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loggedOutput).not.toContain('Pass123!');
    expect(loggedOutput).not.toContain('admin-profile-123');
    expect(loggedOutput).not.toContain('auth-id');
    consoleSpy.mockRestore();
  });
});
