import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loginAction } from './actions';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { clearRecoveryContextCookie } from '../../auth/recoveryContext';

vi.mock('server-only', () => ({}));

vi.mock('../../lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock('../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('../../auth/recoveryContext', () => ({
  clearRecoveryContextCookie: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    const err = new Error(`NEXT_REDIRECT: ${path}`);
    (err as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${path};307;;`;
    throw err;
  }),
}));

describe('loginAction Server Action Unit & Security Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clearRecoveryContextCookie).mockResolvedValue();
  });

  it('1. Missing email or password returns the required-fields error', async () => {
    const formData = new FormData();
    formData.append('email', '');
    formData.append('password', '');

    const res = await loginAction(null, formData);
    expect(res).toEqual({ error: 'Please enter both email and password.' });
  });

  it('2. Invalid credentials return a generic invalid-credentials error', async () => {
    const mockAuthClient = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: null },
          error: { message: 'Invalid login credentials' },
        }),
      },
    };
    vi.mocked(createSupabaseServerClient).mockResolvedValue(mockAuthClient as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'wrong-password');

    const res = await loginAction(null, formData);
    expect(res).toEqual({ error: 'Invalid email or password.' });
  });

  it('3. Successful Auth with no admin_users profile signs out and denies access', async () => {
    const mockSignOut = vi.fn().mockResolvedValue({ error: null });
    const mockAuthClient = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'unprovisioned-user-id' } },
          error: null,
        }),
        signOut: mockSignOut,
      },
    };
    vi.mocked(createSupabaseServerClient).mockResolvedValue(mockAuthClient as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);

    const mockAdminClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);

    const formData = new FormData();
    formData.append('email', 'unprovisioned@capstone.test');
    formData.append('password', 'ValidPass123!');

    const res = await loginAction(null, formData);
    expect(mockSignOut).toHaveBeenCalled();
    expect(res).toEqual({ error: 'Access denied. This account is not provisioned as an administrator.' });
  });

  it('4. Successful Auth with valid profile reaches the redirect path', async () => {
    const mockAuthClient = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'valid-admin-user-id' } },
          error: null,
        }),
      },
    };
    vi.mocked(createSupabaseServerClient).mockResolvedValue(mockAuthClient as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);

    const mockAdminClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'admin-profile-123' }, error: null }),
          }),
        }),
      }),
    };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');
    formData.append('redirectTo', '/admin/projects');

    await expect(loginAction(null, formData)).rejects.toThrow('NEXT_REDIRECT: /admin/projects');
    expect(clearRecoveryContextCookie).toHaveBeenCalledTimes(1);
  });

  it('5. Unexpected Auth exception returns a generic safe browser error', async () => {
    vi.mocked(createSupabaseServerClient).mockRejectedValue(new Error('Network socket closed unexpectedly'));

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');

    const res = await loginAction(null, formData);
    expect(res).toEqual({ error: 'An unexpected authentication error occurred.' });
  });

  it('6. Administrative client creation or query failure returns a generic safe browser error', async () => {
    const mockAuthClient = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'valid-user-id' } },
          error: null,
        }),
      },
    };
    vi.mocked(createSupabaseServerClient).mockResolvedValue(mockAuthClient as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
    vi.mocked(createSupabaseAdminClient).mockImplementation(() => {
      throw new Error('Database service key missing');
    });

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');

    const res = await loginAction(null, formData);
    expect(res).toEqual({ error: 'An unexpected authentication error occurred.' });
  });

  it('7. Profile-query database error signs out and denies access safely', async () => {
    const mockSignOut = vi.fn().mockResolvedValue({ error: null });
    const mockAuthClient = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'valid-user-id' } },
          error: null,
        }),
        signOut: mockSignOut,
      },
    };
    vi.mocked(createSupabaseServerClient).mockResolvedValue(mockAuthClient as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);

    const mockAdminClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'Connection timeout' } }),
          }),
        }),
      }),
    };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');

    const res = await loginAction(null, formData);
    expect(mockSignOut).toHaveBeenCalled();
    expect(res).toEqual({ error: 'Access denied. This account is not provisioned as an administrator.' });
  });

  it('8. Redirect paths are sanitised before navigating', async () => {
    const mockAuthClient = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'valid-admin-user-id' } },
          error: null,
        }),
      },
    };
    vi.mocked(createSupabaseServerClient).mockResolvedValue(mockAuthClient as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);

    const mockAdminClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'admin-profile-123' }, error: null }),
          }),
        }),
      }),
    };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');
    formData.append('redirectTo', 'https://malicious-site.test/phishing');

    await expect(loginAction(null, formData)).rejects.toThrow('NEXT_REDIRECT: /admin');
  });

  it('9. A Next.js redirect control-flow exception is rethrown intact', async () => {
    const mockAuthClient = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'valid-admin-user-id' } },
          error: null,
        }),
      },
    };
    vi.mocked(createSupabaseServerClient).mockResolvedValue(mockAuthClient as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);

    const mockAdminClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'admin-profile-123' }, error: null }),
          }),
        }),
      }),
    };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(mockAdminClient as unknown as ReturnType<typeof createSupabaseAdminClient>);

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');

    let caughtErr: unknown;
    try {
      await loginAction(null, formData);
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeDefined();
    expect((caughtErr as { digest: string }).digest).toContain('NEXT_REDIRECT');
  });

  it('10. A stale recovery-context cleanup failure terminates the new login session', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'valid-admin-user-id' } },
          error: null,
        }),
        signOut,
      },
    } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
    vi.mocked(clearRecoveryContextCookie).mockRejectedValueOnce(new Error('cookie write failed'));

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');

    await expect(loginAction(null, formData)).resolves.toEqual({
      error: 'An unexpected authentication error occurred.',
    });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('11. A resolved sign-out error after stale-context cleanup failure remains generic and fail-closed', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: { message: 'private provider detail' } });
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: { user: { id: 'valid-admin-user-id' } },
          error: null,
        }),
        signOut,
      },
    } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
    vi.mocked(clearRecoveryContextCookie).mockRejectedValueOnce(new Error('cookie write failed'));

    const formData = new FormData();
    formData.append('email', 'admin@capstone.test');
    formData.append('password', 'ValidPass123!');

    await expect(loginAction(null, formData)).resolves.toEqual({
      error: 'An unexpected authentication error occurred.',
    });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
