// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffInvitationForm } from './StaffInvitationForm';
import { ASSIGNABLE_STAFF_ROLES } from '../../staff/staffDirectory';

const fetchMock = vi.fn();

function renderForm(provisioningEnabled = true) {
  return render(
    <StaffInvitationForm assignableRoles={ASSIGNABLE_STAFF_ROLES} provisioningEnabled={provisioningEnabled} />,
  );
}

function fill(values: { fullName?: string; email?: string; role?: string }) {
  if (values.fullName !== undefined) {
    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: values.fullName } });
  }
  if (values.email !== undefined) {
    fireEvent.change(screen.getByLabelText(/Email address/i), { target: { value: values.email } });
  }
  if (values.role !== undefined) {
    fireEvent.click(screen.getByLabelText(new RegExp(values.role, 'i')));
  }
}

function respond(status: number, payload: unknown) {
  fetchMock.mockResolvedValue({ status, json: async () => payload });
}

describe('StaffInvitationForm rendered boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders accessible name, email and role controls', () => {
    renderForm();

    expect(screen.getByLabelText(/Full name/i)).toBeDefined();
    expect(screen.getByLabelText(/Email address/i)).toBeDefined();
    expect(screen.getByLabelText(/Administrator/i)).toBeDefined();
    expect(screen.getByLabelText(/Reviewer/i)).toBeDefined();
    expect(screen.getByLabelText(/Editor/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Send invitation/i })).toBeDefined();
  });

  it('states that the invitee sets their own password', () => {
    renderForm();
    expect(screen.getByText(/sets their own password/i)).toBeDefined();
  });

  it('keeps submission disabled until name, email and at least one role are present', () => {
    renderForm();
    const submit = screen.getByRole('button', { name: /Send invitation/i }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    fill({ fullName: 'Synthetic Staff' });
    expect(submit.disabled).toBe(true);
    fill({ email: 'staff@example.com' });
    expect(submit.disabled).toBe(true);
    fill({ role: 'Reviewer' });
    expect(submit.disabled).toBe(false);
  });

  it('posts only the target name, email and roles to the governed endpoint', async () => {
    respond(202, { code: 'INVITATION_PENDING', message: 'Invitation sent.' });
    renderForm();
    fill({ fullName: '  Synthetic Staff  ', email: ' Staff@Example.com ', role: 'Reviewer' });
    fireEvent.click(screen.getByRole('button', { name: /Send invitation/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/staff/invitations');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['email', 'fullName', 'roles']);
    expect(body.roles).toEqual(['reviewer']);
  });

  it('prevents a duplicate submit while a request is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    renderForm();
    fill({ fullName: 'Synthetic Staff', email: 'staff@example.com', role: 'Reviewer' });

    const submit = screen.getByRole('button', { name: /Send invitation|Sending invitation/i });
    fireEvent.click(submit);
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    release({ status: 202, json: async () => ({ code: 'INVITATION_PENDING', message: 'Invitation sent.' }) });
  });

  it('announces the pending invitation and clears the form on success', async () => {
    respond(202, { code: 'INVITATION_PENDING', message: 'Invitation sent. Access begins after setup.' });
    renderForm();
    fill({ fullName: 'Synthetic Staff', email: 'staff@example.com', role: 'Reviewer' });
    fireEvent.click(screen.getByRole('button', { name: /Send invitation/i }));

    await waitFor(() => expect(screen.getByText(/Invitation pending/i)).toBeDefined());
    expect((screen.getByLabelText(/Full name/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Email address/i) as HTMLInputElement).value).toBe('');
  });

  it('surfaces a server validation rejection without clearing the entered values', async () => {
    respond(400, { code: 'VALIDATION_FAILED', message: 'Check the name, email address and selected roles.' });
    renderForm();
    fill({ fullName: 'Synthetic Staff', email: 'not-an-email', role: 'Reviewer' });
    fireEvent.click(screen.getByRole('button', { name: /Send invitation/i }));

    await waitFor(() => expect(screen.getByText(/Invitation not sent/i)).toBeDefined());
    expect((screen.getByLabelText(/Email address/i) as HTMLInputElement).value).toBe('not-an-email');
  });

  it('surfaces a server permission rejection returned to the browser', async () => {
    respond(403, { code: 'PERMISSION_DENIED', message: 'Access denied.' });
    renderForm();
    fill({ fullName: 'Synthetic Staff', email: 'staff@example.com', role: 'Administrator' });
    fireEvent.click(screen.getByRole('button', { name: /Send invitation/i }));

    await waitFor(() => expect(screen.getByText('Access denied.')).toBeDefined());
  });

  it('reports a bounded failure when the request itself cannot complete', async () => {
    fetchMock.mockRejectedValue(new Error('relation "auth.users" does not exist'));
    renderForm();
    fill({ fullName: 'Synthetic Staff', email: 'staff@example.com', role: 'Reviewer' });
    fireEvent.click(screen.getByRole('button', { name: /Send invitation/i }));

    await waitFor(() => expect(screen.getByText(/Invitation not sent/i)).toBeDefined());
    expect(document.body.textContent).not.toContain('auth.users');
  });

  it('replaces the form with a bounded unavailable state when provisioning is not enabled', () => {
    renderForm(false);

    expect(screen.queryByLabelText(/Full name/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Send invitation/i })).toBeNull();
    expect(screen.getByText(/Invitations are unavailable/i)).toBeDefined();
    expect(screen.getByText(/Existing staff access and pending setup remain visible/i)).toBeDefined();
  });

  it('communicates outcomes through a polite live region rather than colour alone', async () => {
    respond(202, { code: 'INVITATION_PENDING', message: 'Invitation sent.' });
    renderForm();
    fill({ fullName: 'Synthetic Staff', email: 'staff@example.com', role: 'Reviewer' });
    fireEvent.click(screen.getByRole('button', { name: /Send invitation/i }));

    await waitFor(() => {
      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toContain('Invitation pending');
    });
  });
});
