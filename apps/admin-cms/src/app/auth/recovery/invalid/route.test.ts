import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  signOut: vi.fn(),
  clearContext: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('../../../../auth/recoveryContext', () => ({
  clearRecoveryContextCookie: mocks.clearContext,
}));

import { GET } from './route';

describe('invalid recovery cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.clearContext.mockResolvedValue(undefined);
    mocks.createServerClient.mockResolvedValue({ auth: { signOut: mocks.signOut } });
  });

  it('clears context only after successful local session termination', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/auth/recovery/invalid'));
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.clearContext).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
    );
  });

  it('preserves context when sign-out resolves with a private provider error', async () => {
    mocks.signOut.mockResolvedValueOnce({ error: { message: 'private provider detail' } });
    const response = await GET(new NextRequest('http://localhost:3000/auth/recovery/invalid'));
    expect(mocks.clearContext).not.toHaveBeenCalled();
    expect(response.headers.get('Location')).toBe(
      'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
    );
    expect(await response.text()).not.toContain('private provider detail');
  });

  it('preserves context when client creation or sign-out throws', async () => {
    mocks.createServerClient.mockRejectedValueOnce(new Error('private client detail'));
    const response = await GET(new NextRequest('http://localhost:3000/auth/recovery/invalid'));
    expect(mocks.clearContext).not.toHaveBeenCalled();
    expect(response.headers.get('Location')).toBe(
      'http://localhost:3000/login?error=RECOVERY_LINK_INVALID',
    );
  });
});
