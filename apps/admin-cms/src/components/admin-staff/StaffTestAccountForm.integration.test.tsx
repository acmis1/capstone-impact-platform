// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { StaffInvitationForm } from './StaffInvitationForm';
import { StaffTestAccountForm } from './StaffTestAccountForm';
import { ASSIGNABLE_STAFF_ROLES } from '../../staff/staffDirectory';

const fetchMock = vi.fn();
const SYNTHETIC_PASSWORD = 'SyntheticOnly!234';

function fill() {
  fireEvent.change(screen.getByLabelText(/^Full name/i), {
    target: { value: 'Synthetic UAT Staff' },
  });
  fireEvent.change(screen.getByLabelText(/^Email \/ login/i), {
    target: { value: 'uat.staff@capstone.test' },
  });
  fireEvent.change(screen.getByLabelText(/^Password/i), {
    target: { value: SYNTHETIC_PASSWORD },
  });
  fireEvent.change(screen.getByLabelText(/^Confirm password/i), {
    target: { value: SYNTHETIC_PASSWORD },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Editor' }));
}

describe('StaffTestAccountForm rendered boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not render when server-resolved staging eligibility is false', () => {
    render(<StaffTestAccountForm available={false} />);
    expect(screen.queryByText(/Create test account/i)).toBeNull();
  });

  it('renders only Reviewer and Editor with password controls when available', () => {
    render(<StaffTestAccountForm available />);
    expect(screen.getByRole('heading', { name: /Create test account/i })).toBeDefined();
    expect(screen.getByText(/Staging only/i)).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Reviewer' })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Editor' })).toBeDefined();
    expect(screen.queryByLabelText(/Administrator/i)).toBeNull();
    expect(screen.getByLabelText(/^Password/i)).toBeDefined();
    expect(screen.getByLabelText(/^Confirm password/i)).toBeDefined();
    expect(screen.getByText(/No setup email is sent/i)).toBeDefined();
  });

  it('keeps role names exact and descriptions separately associated', () => {
    render(<StaffTestAccountForm available />);

    const descriptions = {
      Reviewer: 'Can read projects and complete review decisions.',
      Editor: 'Can read and edit project metadata and import projects.',
    };

    for (const [role, description] of Object.entries(descriptions)) {
      const roleKey = role.toLowerCase();
      const checkbox = screen.getByRole('checkbox', { name: role }) as HTMLInputElement;
      expect(checkbox.getAttribute('aria-labelledby')).toBe(`test-account-role-${roleKey}-label`);
      const descriptionId = `test-account-role-${roleKey}-description`;
      expect(checkbox.getAttribute('aria-describedby')).toBe(descriptionId);
      expect(document.getElementById(descriptionId)?.textContent).toBe(description);
    }
  });

  it('toggles a role when its full row is clicked', () => {
    render(<StaffTestAccountForm available />);

    const checkbox = screen.getByRole('checkbox', { name: 'Reviewer' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(screen.getByText('Reviewer'));
    expect(checkbox.checked).toBe(true);
  });

  it('preserves bounded password and autocomplete semantics', () => {
    render(<StaffTestAccountForm available />);
    const password = screen.getByLabelText(/^Password/i) as HTMLInputElement;
    const confirmation = screen.getByLabelText(/^Confirm password/i) as HTMLInputElement;

    expect(password.minLength).toBe(12);
    expect(password.maxLength).toBe(128);
    expect(password.autocomplete).toBe('new-password');
    expect(confirmation.minLength).toBe(12);
    expect(confirmation.maxLength).toBe(128);
    expect(confirmation.autocomplete).toBe('new-password');
    expect(screen.getByText(/password is cleared from this page after every attempt/i)).toBeDefined();
  });

  it('keeps submit disabled until every field is valid and passwords match', () => {
    render(<StaffTestAccountForm available />);
    const submit = screen.getByRole('button', { name: /^Create test account$/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fill();
    expect(submit.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/^Confirm password/i), {
      target: { value: 'SyntheticOnly!999' },
    });
    expect(submit.disabled).toBe(true);
  });

  it('posts exactly the five allowed fields with Reviewer + Editor', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ code: 'ACCOUNT_READY', message: 'Account ready.' }),
    });
    render(<StaffTestAccountForm available />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /^Create test account$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/staff/test-accounts');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual([
      'confirmation',
      'email',
      'fullName',
      'password',
      'roles',
    ]);
    expect(body.roles).toEqual(['reviewer', 'editor']);
  });

  it('uses a synchronous lock to prevent duplicate submission', async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    render(<StaffTestAccountForm available />);
    fill();
    const form = screen.getByRole('button', { name: /^Create test account$/i }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release({ json: async () => ({ code: 'ACCOUNT_READY', message: 'Account ready.' }) });
  });

  it('clears credentials, announces bounded success and refreshes the directory', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        code: 'ACCOUNT_READY',
        message: 'Staging test account created. The account is ready to sign in.',
      }),
    });
    render(<StaffTestAccountForm available />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /^Create test account$/i }));

    await waitFor(() => expect(screen.getByText(/Account ready/i)).toBeDefined());
    expect((screen.getByLabelText(/^Password/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^Confirm password/i) as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain(SYNTHETIC_PASSWORD);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('shows a safe failure and clears credential fields', async () => {
    fetchMock.mockRejectedValue(new Error('synthetic raw provider detail'));
    render(<StaffTestAccountForm available />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /^Create test account$/i }));

    await waitFor(() => expect(screen.getByText(/Account not created/i)).toBeDefined());
    expect(document.body.textContent).not.toContain('synthetic raw provider detail');
    expect((screen.getByLabelText(/^Password/i) as HTMLInputElement).value).toBe('');
  });

  it('leaves the existing invitation surface unchanged beside the direct form', () => {
    render(
      <>
        <StaffInvitationForm assignableRoles={ASSIGNABLE_STAFF_ROLES} provisioningEnabled />
        <StaffTestAccountForm available />
      </>,
    );
    expect(screen.getByRole('button', { name: /Send invitation/i })).toBeDefined();
    expect(screen.getByText(/sets their own password/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Create test account$/i })).toBeDefined();
  });
});
