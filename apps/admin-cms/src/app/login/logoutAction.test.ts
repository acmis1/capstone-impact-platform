import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockSignOut = vi.fn();
const mockSupabaseServerClient = {
  auth: {
    signOut: mockSignOut,
  },
};

vi.mock('../../lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => mockSupabaseServerClient),
}));

const { mockClearRecoveryContextCookie } = vi.hoisted(() => ({
  mockClearRecoveryContextCookie: vi.fn(),
}));
vi.mock('../../auth/recoveryContext', () => ({
  clearRecoveryContextCookie: mockClearRecoveryContextCookie,
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`);
    (err as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;;`;
    throw err;
  }),
}));

import { logoutAction } from './actions';
import { createSupabaseServerClient } from '../../lib/supabase/server';

describe('logoutAction Server Action Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearRecoveryContextCookie.mockResolvedValue(undefined);
  });

  it('1. Creates Supabase server client and calls auth.signOut() exactly once', async () => {
    mockSignOut.mockResolvedValueOnce({ error: null });

    await expect(logoutAction()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(createSupabaseServerClient).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockClearRecoveryContextCookie).toHaveBeenCalledTimes(1);
  });

  it('2. Preserves NEXT_REDIRECT exception even if signOut throws an unexpected error', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('Network error during sign out'));

    await expect(logoutAction()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(createSupabaseServerClient).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockClearRecoveryContextCookie).toHaveBeenCalledTimes(1);
  });

  it('3. Preserves NEXT_REDIRECT exception even if createSupabaseServerClient throws', async () => {
    vi.mocked(createSupabaseServerClient).mockRejectedValueOnce(new Error('Client creation failed'));

    await expect(logoutAction()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(mockClearRecoveryContextCookie).toHaveBeenCalledTimes(1);
  });
});
