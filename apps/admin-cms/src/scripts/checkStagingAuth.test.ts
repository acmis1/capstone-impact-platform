import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runCheckStagingAuth } from './checkStagingAuth';

describe('checkStagingAuth Script Contract & Exit Semantics Tests', () => {
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
            data: [{ id: 'admin-1', auth_user_id: 'auth-1' }],
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
              data: [{ id: 'role-1', user_id: 'admin-1', role: 'admin' }],
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
              data: [{ id: 'appr-1', admin_id: 'admin-1' }],
              error: null,
            });
          }),
        };
      }
      return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
    });

    const mockClient = { from: mockFrom };
    const result = await runCheckStagingAuth([], () => mockClient);

    expect(result.classification).toBe('READY_FOR_MANUAL_LOGIN_TEST');
    expect(result.exitCode).toBe(0);
    expect(mockFrom).toHaveBeenCalledWith('user_roles');
    expect(mockFrom).toHaveBeenCalledWith('approval_records');
  });

  it('2. Ready auth setup maps to READY_FOR_MANUAL_LOGIN_TEST classification and exit code 0', async () => {
    const mockClient = {
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

    const result = await runCheckStagingAuth([], () => mockClient);

    expect(result.classification).toBe('READY_FOR_MANUAL_LOGIN_TEST');
    expect(result.exitCode).toBe(0);
  });

  it('3. Incomplete auth setup maps to INCOMPLETE classification and exit code 2', async () => {
    const mockClient = {
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

    const result = await runCheckStagingAuth([], () => mockClient);

    expect(result.classification).toBe('INCOMPLETE');
    expect(result.exitCode).toBe(2);
  });

  it('4. Connection or query exception maps to FAILED classification and exit code 1', async () => {
    const mockClientFactory = () => {
      throw new Error('Database connection failed');
    };

    const result = await runCheckStagingAuth([], mockClientFactory);

    expect(result.classification).toBe('FAILED');
    expect(result.exitCode).toBe(1);
  });

  it('5. Guard invocation occurs BEFORE client creation', async () => {
    delete process.env.CAPSTONE_RUNTIME_ENV;

    const mockFactory = vi.fn();

    await expect(runCheckStagingAuth([], mockFactory)).rejects.toThrowError(/Staging Execution Refused/);
    expect(mockFactory).not.toHaveBeenCalled();
  });
});
