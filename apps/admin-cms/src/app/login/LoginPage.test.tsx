// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('./actions', () => ({
  loginAction: vi.fn(),
  logoutAction: vi.fn(),
}));

import LoginPage from './page';

describe('LoginPage and LoginForm rendered contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders required email and password fields with correct autocomplete and types', () => {
    render(<LoginPage />);

    const emailInput = screen.getByLabelText(/Email/i) as HTMLInputElement;
    expect(emailInput).toBeDefined();
    expect(emailInput.type).toBe('email');
    expect(emailInput.name).toBe('email');
    expect(emailInput.required).toBe(true);
    expect(emailInput.autocomplete).toBe('email');

    const passwordInput = screen.getByLabelText(/Password/i) as HTMLInputElement;
    expect(passwordInput).toBeDefined();
    expect(passwordInput.type).toBe('password');
    expect(passwordInput.name).toBe('password');
    expect(passwordInput.required).toBe(true);
    expect(passwordInput.autocomplete).toBe('current-password');
  });

  it('renders hidden redirectTo input with default /admin', () => {
    const { container } = render(<LoginPage />);
    const hiddenRedirect = container.querySelector('input[name="redirectTo"]') as HTMLInputElement;
    expect(hiddenRedirect).not.toBeNull();
    expect(hiddenRedirect.value).toBe('/admin');
  });

  it('preserves query param redirectTo or next in hidden input', () => {
    mocks.searchParams = new URLSearchParams('next=/admin/imports');
    const { container } = render(<LoginPage />);
    const hiddenRedirect = container.querySelector('input[name="redirectTo"]') as HTMLInputElement;
    expect(hiddenRedirect).not.toBeNull();
    expect(hiddenRedirect.value).toBe('/admin/imports');
  });

  it('renders submit button with text Sign in', () => {
    render(<LoginPage />);
    const submitBtn = screen.getByRole('button', { name: /^Sign in$/i });
    expect(submitBtn).toBeDefined();
    expect((submitBtn as HTMLButtonElement).type).toBe('submit');
  });

  it('renders a keyboard-reachable forgot-password link with the exact destination', () => {
    render(<LoginPage />);
    const link = screen.getByRole('link', { name: /Forgot password\?/i });
    expect(link.getAttribute('href')).toBe('/auth/forgot-password');
  });

  it('maps known URL error codes to alert message', () => {
    mocks.searchParams = new URLSearchParams('error=SESSION_EXPIRED');
    render(<LoginPage />);
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText(/Session expired\. Please click the invitation link again\./i)).toBeDefined();
  });

  it('maps PASSWORD_SET URL status to success alert message', () => {
    mocks.searchParams = new URLSearchParams('status=PASSWORD_SET');
    render(<LoginPage />);
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.getByText(/Security credentials established successfully\. Please sign in below\./i)).toBeDefined();
  });

  it('maps PASSWORD_RESET separately from invitation password establishment', () => {
    mocks.searchParams = new URLSearchParams('status=PASSWORD_RESET');
    render(<LoginPage />);
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.getByText('Your password has been reset. Sign in with your new password.')).toBeDefined();
  });

  it('displays authorised staff notice', () => {
    render(<LoginPage />);
    expect(screen.getByText(/Access is provided to authorised School staff\./i)).toBeDefined();
  });
});
