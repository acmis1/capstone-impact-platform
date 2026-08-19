import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthError } from '../../auth/authTypes';

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), redirect: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../components/admin-shell/AdminShellClient', () => ({
  AdminShellClient: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../components/admin-shell/AuthErrorScreen', () => ({
  AuthErrorScreen: () => null,
}));
vi.mock('next/navigation', () => ({
  redirect: mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

import AdminLayout from './layout';

describe('Admin layout recovery redirect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects a recovery-purpose authenticated session only to reset-password', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new AdminAuthError('PASSWORD_RECOVERY_REQUIRED', 'Password recovery must be completed.'),
    );
    await expect(AdminLayout({ children: <div>private Admin content</div> })).rejects.toThrow(
      'NEXT_REDIRECT:/auth/reset-password',
    );
  });

  it('does not create a reset redirect loop for unsupported authentication provenance', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new AdminAuthError(
        'AUTHENTICATION_PROVENANCE_INVALID',
        'Authentication cannot be used for administrative access.',
      ),
    );
    await expect(AdminLayout({ children: <div>private Admin content</div> })).resolves.toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
