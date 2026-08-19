// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
}));

vi.mock('../../../lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: { resetPasswordForEmail: mocks.resetPasswordForEmail },
  }),
}));

import ForgotPasswordPage from './page';

const SUCCESS =
  'If an account exists for that email address, a password reset link will be sent. Check your inbox and spam folder.';

describe('public password-recovery request page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => cleanup());

  it('renders only the required email field and exact navigation', () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeDefined();
    const email = screen.getByRole('textbox', { name: /Email/ }) as HTMLInputElement;
    expect(email.name).toBe('email');
    expect(email.type).toBe('email');
    expect(email.required).toBe(true);
    expect(email.autocomplete).toBe('email');
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe('/login');
  });

  it('trims surrounding whitespace and calls the browser client with the exact callback', async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByRole('textbox', { name: /Email/ }), { target: { value: '  staff@example.test  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await screen.findByText(SUCCESS);
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledOnce();
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith('staff@example.test', {
      redirectTo: `${window.location.origin}/auth/recovery/callback`,
    });
  });

  it('presents identical text and status shape for existing and nonexistent provider outcomes', async () => {
    const presentations: string[] = [];
    for (const providerResult of [
      { data: {}, error: null },
      { data: null, error: { message: 'synthetic provider detail' } },
    ]) {
      mocks.resetPasswordForEmail.mockResolvedValueOnce(providerResult);
      const rendered = render(<ForgotPasswordPage />);
      fireEvent.change(screen.getByRole('textbox', { name: /Email/ }), { target: { value: 'person@example.test' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
      const status = await screen.findByRole('status');
      presentations.push(status.textContent ?? '');
      rendered.unmount();
    }
    expect(presentations).toEqual([
      `Check your email${SUCCESS}`,
      `Check your email${SUCCESS}`,
    ]);
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed email locally without issuing a provider request', async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByRole('textbox', { name: /Email/ }), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeDefined();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('locks duplicate effective submissions while pending', async () => {
    let resolveRequest: ((value: { data: Record<string, never>; error: null }) => void) | undefined;
    mocks.resetPasswordForEmail.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRequest = resolve; }),
    );
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByRole('textbox', { name: /Email/ }), { target: { value: 'staff@example.test' } });
    const button = screen.getByRole('button', { name: 'Send reset link' });
    fireEvent.click(button);
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    await waitFor(() => expect(
      (screen.getByRole('button', { name: 'Sending reset link…' }) as HTMLButtonElement).disabled,
    ).toBe(true));
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledOnce();
    resolveRequest?.({ data: {}, error: null });
    await screen.findByText(SUCCESS);
  });

  it('returns one bounded retry message for a true client failure', async () => {
    mocks.resetPasswordForEmail.mockRejectedValueOnce(new Error('private client configuration detail'));
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByRole('textbox', { name: /Email/ }), { target: { value: 'staff@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('The reset request could not be sent. Please try again later.')).toBeDefined();
    expect(screen.queryByText(/private client/i)).toBeNull();
  });

  it('contains no admin lookup, role lookup, service-role usage, or URL email transport', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'ForgotPasswordForm.tsx'), 'utf8');
    expect(source).not.toMatch(/admin_users|auth\.users|user_roles|service[_-]?role/i);
    expect(source).not.toMatch(/searchParams|URLSearchParams/);
    expect(source).toContain('createSupabaseBrowserClient');
    expect(source).toContain('resetPasswordForEmail');
  });
});
