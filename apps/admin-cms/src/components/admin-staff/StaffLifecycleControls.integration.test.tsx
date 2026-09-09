// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { StaffLifecycleControls } from './StaffLifecycleControls';
import type { StaffDirectoryEntry } from '../../staff/staffProvisioningRepository';

const fetchMock = vi.fn();
const ACTIVE_STAFF: StaffDirectoryEntry = {
  fullName: 'Synthetic Reviewer',
  email: 'reviewer@capstone.test',
  roles: ['reviewer'],
  status: 'active',
  version: 7,
  providerSync: 'synchronized',
  lastChangedAt: '2026-09-09T10:10:00.000Z',
  requestedAt: null,
};

function respond(status: number, payload: unknown) {
  fetchMock.mockResolvedValue({ status, json: async () => payload });
}

describe('StaffLifecycleControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('exposes no lifecycle action for the current staff identity', () => {
    render(<StaffLifecycleControls staff={ACTIVE_STAFF} isCurrentUser />);

    expect(screen.getByText('Your own access cannot be changed here.')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('replaces the complete recognized role set with the rendered version fence', async () => {
    respond(200, { success: true, code: 'UPDATED', message: 'Staff access updated.' });
    render(<StaffLifecycleControls staff={ACTIVE_STAFF} isCurrentUser={false} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace roles' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace roles' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/staff/lifecycle');
    expect(JSON.parse(init.body)).toEqual({
      action: 'replace_roles',
      targetEmail: 'reviewer@capstone.test',
      expectedVersion: 7,
      roles: ['reviewer', 'editor'],
    });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('requires explicit confirmation before deactivation', async () => {
    respond(202, {
      success: true,
      code: 'UPDATED_PROVIDER_ATTENTION',
      message: 'Admin/CMS access is deactivated. Sign-in cleanup needs attention.',
    });
    render(<StaffLifecycleControls staff={ACTIVE_STAFF} isCurrentUser={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate access' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: 'deactivate',
      targetEmail: 'reviewer@capstone.test',
      expectedVersion: 7,
    });
    expect(await screen.findByText(/Sign-in cleanup needs attention/i)).toBeDefined();
  });

  it('allows only provider reconciliation while synchronization is unresolved', async () => {
    respond(200, {
      success: true,
      code: 'PROVIDER_SYNCHRONIZED',
      message: 'Sign-in access is synchronized.',
    });
    render(
      <StaffLifecycleControls
        staff={{ ...ACTIVE_STAFF, providerSync: 'attention_required' }}
        isCurrentUser={false}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry sign-in sync' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry synchronization' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: 'reconcile',
      targetEmail: 'reviewer@capstone.test',
      expectedVersion: 7,
    });
  });

  it('reactivates only with an explicit non-empty recognized role selection', async () => {
    respond(200, { success: true, code: 'UPDATED', message: 'Staff access updated.' });
    render(
      <StaffLifecycleControls
        staff={{ ...ACTIVE_STAFF, roles: [], status: 'deactivated', version: 8 }}
        isCurrentUser={false}
      />,
    );

    const reactivate = screen.getByRole('button', { name: 'Reactivate' }) as HTMLButtonElement;
    expect(reactivate.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
    expect(reactivate.disabled).toBe(false);
    fireEvent.click(reactivate);
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate access' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: 'reactivate',
      targetEmail: 'reviewer@capstone.test',
      expectedVersion: 8,
      roles: ['reviewer'],
    });
  });
});
