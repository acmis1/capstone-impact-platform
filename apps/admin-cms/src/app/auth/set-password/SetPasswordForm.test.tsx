// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setPasswordAction: vi.fn(),
}));

vi.mock('./actions', () => ({ setPasswordAction: mocks.setPasswordAction }));

import { SetPasswordForm } from './SetPasswordForm';

describe('invitation set-password form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => cleanup());

  async function submitWith(error: string) {
    mocks.setPasswordAction.mockResolvedValueOnce({ error });
    render(<SetPasswordForm />);
    const password = screen.getByLabelText('New Password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'ValidPassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'ValidPassword1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Establish Security Credentials' }));
    return password;
  }

  it('shows compromised-password guidance, marks the password invalid, and clears on change', async () => {
    const password = await submitWith('PASSWORD_COMPROMISED');

    await screen.findByText(
      'This password has appeared in a known data breach. Choose a different password.',
    );
    expect(password.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(password, { target: { value: 'DifferentPassword1' } });
    expect(screen.queryByText(/known data breach/)).toBeNull();
    expect(password.getAttribute('aria-invalid')).toBe('false');
  });

  it('keeps the generic provider failure message', async () => {
    await submitWith('PASSWORD_UPDATE_FAILED');
    await screen.findByText('Failed to update password.');
  });
});
