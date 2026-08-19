// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyAccess: vi.fn(),
  createServerClient: vi.fn(),
  resetAction: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../../auth/recoverySession', () => ({
  getVerifiedPasswordRecoveryAccess: mocks.verifyAccess,
}));
vi.mock('../../../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));
vi.mock('./actions', () => ({ resetPasswordAction: mocks.resetAction }));
vi.mock('../../login/actions', () => ({ logoutAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

import ResetPasswordPage from './page';

describe('recovery reset-password page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerClient.mockResolvedValue({ auth: { getClaims: vi.fn() }, rpc: vi.fn() });
    mocks.verifyAccess.mockResolvedValue({
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      authenticationMethods: ['otp'],
    });
    mocks.resetAction.mockResolvedValue({ error: 'PASSWORD_UPDATE_FAILED' });
  });

  afterEach(() => cleanup());

  it('requires verified claims, durable state, and exact user/session-bound context', async () => {
    mocks.verifyAccess.mockResolvedValueOnce(null);
    await expect(ResetPasswordPage()).rejects.toThrow(
      'NEXT_REDIRECT:/auth/recovery/invalid',
    );
  });

  it('renders only required new-password fields without user identity', async () => {
    render(await ResetPasswordPage());
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeDefined();
    const password = screen.getByLabelText(/New password/) as HTMLInputElement;
    const confirmation = screen.getByLabelText(/Confirm new password/) as HTMLInputElement;
    for (const input of [password, confirmation]) {
      expect(input.type).toBe('password');
      expect(input.required).toBe(true);
      expect(input.autocomplete).toBe('new-password');
      expect(input.minLength).toBe(12);
      expect(input.maxLength).toBe(128);
    }
    expect(document.body.textContent).not.toMatch(/@|11111111-1111/);
  });

  it('prevents duplicate effective submission while the action is pending', async () => {
    let resolveAction: ((value: { error: string }) => void) | undefined;
    mocks.resetAction.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAction = resolve; }),
    );
    render(await ResetPasswordPage());
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'ValidPassword1' } });
    fireEvent.change(screen.getByLabelText(/Confirm new password/), { target: { value: 'ValidPassword1' } });
    const button = screen.getByRole('button', { name: 'Reset password' });
    fireEvent.click(button);
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    await waitFor(() => expect(
      (screen.getByRole('button', { name: 'Updating password…' }) as HTMLButtonElement).disabled,
    ).toBe(true));
    expect(mocks.resetAction).toHaveBeenCalledOnce();
    resolveAction?.({ error: 'PASSWORD_UPDATE_FAILED' });
    await screen.findByText('The password could not be updated. Please try again.');
  });
});
