import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runCheckStagingAuth, checkStagingAuthWithClient, StagingAuthCheckClient } from './checkStagingAuth';
import * as adminCore from '../lib/supabase/adminCore';

describe('checkStagingAuth Worker & Runner Contract Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAPSTONE_RUNTIME_ENV = 'staging';
    process.env.CAPSTONE_EXPECTED_SUPABASE_HOST = 'app-staging.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://app-staging.supabase.co';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('1. Queries user_id from user_roles and admin_id from approval_records accurately', async () => {
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'admin_users') {
        return {
          select: vi.fn().mockResolvedValue({
            data: [{ id: 'admin-uuid-123', auth_user_id: 'auth-uuid-456' }],
            error: null,
          }),
        };
      }
      if (table === 'user_roles') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            expect(cols).toContain('user_id');
            expect(cols).not.toContain('admin_user_id');
            return Promise.resolve({
              data: [{ id: 'role-1', user_id: 'admin-uuid-123', role: 'admin' }],
              error: null,
            });
          }),
        };
      }
      if (table === 'approval_records') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            expect(cols).toContain('admin_id');
            expect(cols).not.toContain('admin_user_id');
            return Promise.resolve({
              data: [{ id: 'appr-1', admin_id: 'admin-uuid-123' }],
              error: null,
            });
          }),
        };
      }
      return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
    });

    const mockClient: StagingAuthCheckClient = { from: mockFrom };
    const result = await checkStagingAuthWithClient(mockClient);

    expect(result.classification).toBe('READY_FOR_MANUAL_LOGIN_TEST');
    expect(result.exitCode).toBe(0);
    expect(mockFrom).toHaveBeenCalledWith('user_roles');
    expect(mockFrom).toHaveBeenCalledWith('approval_records');
  });

  it('2. Complete ready output prints classification=READY_FOR_MANUAL_LOGIN_TEST and exit code 0', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockClient: StagingAuthCheckClient = {
      from: vi.fn((table: string) => {
        if (table === 'admin_users') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'admin-1', auth_user_id: 'auth-1' }], error: null }) };
        }
        if (table === 'user_roles') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'r-1', user_id: 'admin-1', role: 'admin' }], error: null }) };
        }
        if (table === 'approval_records') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'a-1', admin_id: 'admin-1' }], error: null }) };
        }
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }),
    };

    const result = await checkStagingAuthWithClient(mockClient);

    expect(result.classification).toBe('READY_FOR_MANUAL_LOGIN_TEST');
    expect(result.exitCode).toBe(0);

    const loggedLines = logSpy.mock.calls.map((call) => call[0]);
    expect(loggedLines).toContain('classification=READY_FOR_MANUAL_LOGIN_TEST');
    expect(loggedLines).toContain('migration_present=YES');
    expect(loggedLines).toContain('admin_users_count=1');
    expect(loggedLines).toContain('linked_auth_users_count=1');
    expect(loggedLines).toContain('unlinked_admin_users_count=0');
    expect(loggedLines).toContain('recognized_role_assignments=1');
    expect(loggedLines).toContain('invalid_role_assignments=0');
    expect(loggedLines).toContain('audit_records_with_actor=1');
    expect(loggedLines).toContain('audit_records_without_actor=0');
    expect(loggedLines).toContain('error_codes=NONE');
    expect(loggedLines).toContain('warning_codes=NONE');
  });

  it('3. Incomplete auth setup prints classification=INCOMPLETE and exit code 2', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockClient: StagingAuthCheckClient = {
      from: vi.fn((table: string) => {
        if (table === 'admin_users') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'admin-1', auth_user_id: null }], error: null }) };
        }
        if (table === 'user_roles') {
          return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
        }
        if (table === 'approval_records') {
          return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
        }
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }),
    };

    const result = await checkStagingAuthWithClient(mockClient);

    expect(result.classification).toBe('INCOMPLETE');
    expect(result.exitCode).toBe(2);

    const loggedLines = logSpy.mock.calls.map((call) => call[0]);
    expect(loggedLines).toContain('classification=INCOMPLETE');
    expect(loggedLines).toContain('error_codes=NO_LINKED_ADMIN');
  });

  it('4. Historical null audit actor records print warning_codes=HISTORICAL_NULL_AUDIT_ACTORS', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockClient: StagingAuthCheckClient = {
      from: vi.fn((table: string) => {
        if (table === 'admin_users') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'admin-1', auth_user_id: 'auth-1' }], error: null }) };
        }
        if (table === 'user_roles') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'r-1', user_id: 'admin-1', role: 'admin' }], error: null }) };
        }
        if (table === 'approval_records') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'a-1', admin_id: null }], error: null }) };
        }
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }),
    };

    const result = await checkStagingAuthWithClient(mockClient);

    expect(result.classification).toBe('READY_FOR_MANUAL_LOGIN_TEST');
    expect(result.exitCode).toBe(0);

    const loggedLines = logSpy.mock.calls.map((call) => call[0]);
    expect(loggedLines).toContain('audit_records_without_actor=1');
    expect(loggedLines).toContain('warning_codes=HISTORICAL_NULL_AUDIT_ACTORS');
  });

  it('5. Invalid role assignment prints error_codes containing INVALID_ROLE_ASSIGNED and classification=INCOMPLETE', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockClient: StagingAuthCheckClient = {
      from: vi.fn((table: string) => {
        if (table === 'admin_users') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'admin-1', auth_user_id: 'auth-1' }], error: null }) };
        }
        if (table === 'user_roles') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'r-1', user_id: 'admin-1', role: 'super_admin_invalid' }], error: null }) };
        }
        if (table === 'approval_records') {
          return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
        }
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }),
    };

    const result = await checkStagingAuthWithClient(mockClient);

    expect(result.classification).toBe('INCOMPLETE');
    expect(result.exitCode).toBe(2);

    const loggedLines = logSpy.mock.calls.map((call) => call[0]);
    expect(loggedLines).toContain('invalid_role_assignments=1');
    const errorCodeLine = loggedLines.find((l) => typeof l === 'string' && l.startsWith('error_codes='));
    expect(errorCodeLine).toBeDefined();
    expect(errorCodeLine).toContain('INVALID_ROLE_ASSIGNED');
  });

  it('6. Console output contains ZERO sensitive names, emails, UUIDs or credential strings', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockClient: StagingAuthCheckClient = {
      from: vi.fn((table: string) => {
        if (table === 'admin_users') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'admin-secret-uuid-999', auth_user_id: 'auth-secret-uuid-888' }], error: null }) };
        }
        if (table === 'user_roles') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'r-1', user_id: 'admin-secret-uuid-999', role: 'admin' }], error: null }) };
        }
        if (table === 'approval_records') {
          return { select: vi.fn().mockResolvedValue({ data: [{ id: 'a-1', admin_id: 'admin-secret-uuid-999' }], error: null }) };
        }
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }),
    };

    await checkStagingAuthWithClient(mockClient);

    const fullLogOutput = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(fullLogOutput).not.toContain('admin-secret-uuid-999');
    expect(fullLogOutput).not.toContain('auth-secret-uuid-888');
    expect(fullLogOutput).not.toContain('@');
    expect(fullLogOutput).not.toContain('http');
  });

  it('7. Public runner runCheckStagingAuth executes guard BEFORE client creation', async () => {
    delete process.env.CAPSTONE_RUNTIME_ENV;

    const adminClientSpy = vi.spyOn(adminCore, 'createSupabaseAdminClientCore');

    await expect(runCheckStagingAuth()).rejects.toThrowError(/Staging Execution Refused/);
    expect(adminClientSpy).not.toHaveBeenCalled();
  });
});
