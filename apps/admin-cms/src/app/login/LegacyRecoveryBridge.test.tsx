// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(),
  createBrowserClient: vi.fn(),
  finalizeRecovery: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('../../lib/supabase/client', () => ({
  createSupabaseBrowserClient: mocks.createBrowserClient,
}));
vi.mock('./recoveryActions', () => ({
  finalizeImplicitRecoveryAction: mocks.finalizeRecovery,
}));

import {
  LegacyRecoveryBridge,
  parseImplicitRecoveryFragment,
} from './LegacyRecoveryBridge';

describe('LegacyRecoveryBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/login');
    mocks.setSession.mockResolvedValue({ data: { session: {} }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.createBrowserClient.mockReturnValue({
      auth: {
        setSession: mocks.setSession,
        signOut: mocks.signOut,
      },
    });
    mocks.finalizeRecovery.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('parses only a single complete recovery fragment and rejects malformed recovery data', () => {
    expect(parseImplicitRecoveryFragment('')).toEqual({ kind: 'none' });
    expect(
      parseImplicitRecoveryFragment('#type=signup&access_token=a&refresh_token=r'),
    ).toEqual({ kind: 'none' });
    expect(parseImplicitRecoveryFragment('#type=recovery')).toEqual({ kind: 'invalid' });
    expect(
      parseImplicitRecoveryFragment('#type=recovery&type=recovery&access_token=a&refresh_token=r'),
    ).toEqual({ kind: 'invalid' });
    expect(
      parseImplicitRecoveryFragment('#type=recovery&access_token=a&refresh_token=r'),
    ).toEqual({ kind: 'recovery', accessToken: 'a', refreshToken: 'r' });
  });

  it('scrubs provider tokens before establishing the browser session and finalizes verified recovery', async () => {
    window.history.replaceState(
      null,
      '',
      '/login?redirectTo=/admin#type=recovery&access_token=synthetic-access&refresh_token=synthetic-refresh&token_type=bearer',
    );

    render(<LegacyRecoveryBridge />);

    await waitFor(() => expect(mocks.setSession).toHaveBeenCalledOnce());
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/login');
    expect(window.location.search).toBe('?redirectTo=/admin');
    expect(mocks.setSession).toHaveBeenCalledWith({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
    });
    await waitFor(() => expect(mocks.finalizeRecovery).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/auth/reset-password'));
  });

  it('fails closed without creating a Supabase client for malformed recovery fragments', async () => {
    window.history.replaceState(null, '', '/login#type=recovery&access_token=only-access');

    render(<LegacyRecoveryBridge />);

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith('/login?error=RECOVERY_LINK_INVALID'),
    );
    expect(window.location.hash).toBe('');
    expect(mocks.createBrowserClient).not.toHaveBeenCalled();
    expect(mocks.finalizeRecovery).not.toHaveBeenCalled();
  });

  it('ignores non-recovery hash fragments', async () => {
    window.history.replaceState(null, '', '/login#section=help');

    render(<LegacyRecoveryBridge />);

    await Promise.resolve();
    expect(window.location.hash).toBe('#section=help');
    expect(mocks.createBrowserClient).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('terminates the local browser session when provider session establishment fails', async () => {
    mocks.setSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: 'provider detail' },
    });
    window.history.replaceState(
      null,
      '',
      '/login#type=recovery&access_token=synthetic-access&refresh_token=synthetic-refresh',
    );

    render(<LegacyRecoveryBridge />);

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    expect(mocks.finalizeRecovery).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/login?error=RECOVERY_LINK_INVALID');
  });

  it('fails generically when server-side recovery provenance is not accepted', async () => {
    mocks.finalizeRecovery.mockResolvedValueOnce({ ok: false });
    window.history.replaceState(
      null,
      '',
      '/login#type=recovery&access_token=synthetic-access&refresh_token=synthetic-refresh',
    );

    render(<LegacyRecoveryBridge />);

    await waitFor(() => expect(mocks.finalizeRecovery).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith('/login?error=RECOVERY_LINK_INVALID'),
    );
  });
});
