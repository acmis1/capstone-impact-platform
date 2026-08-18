// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StaffDirectoryTable } from './StaffDirectoryTable';
import type {
  StaffDirectoryEntry,
  StaffProvisioningIncident,
} from '../../staff/staffProvisioningRepository';

const LONG_NAME = `Synthetic ${'Coordination'.repeat(18)}`;
const LONG_EMAIL = `${'long.local.part'.repeat(12)}@capstone.test`;

const staff: StaffDirectoryEntry[] = [
  {
    fullName: 'Active Administrator',
    email: 'active.admin@capstone.test',
    roles: ['admin'],
    status: 'active',
    requestedAt: '2026-08-13T12:00:00.000Z',
  },
  {
    fullName: LONG_NAME,
    email: LONG_EMAIL,
    roles: ['reviewer', 'editor'],
    status: 'pending_activation',
    requestedAt: 'not-a-timestamp',
  },
  {
    fullName: '',
    email: 'unrecognized@capstone.test',
    roles: [],
    status: 'active',
    requestedAt: null,
  },
];

const incidents: StaffProvisioningIncident[] = [
  {
    fullName: 'Cleanup Pending',
    email: 'cleanup@capstone.test',
    roles: ['reviewer'],
    status: 'compensating',
    failureCode: null,
    requestedAt: '2026-08-14T08:15:00.000Z',
  },
  {
    fullName: 'Attention Required',
    email: 'attention@capstone.test',
    roles: ['editor'],
    status: 'compensation_failed',
    failureCode: 'BOUNDED_INTERNAL_FAILURE',
    requestedAt: '2026-08-14T09:30:00.000Z',
  },
  {
    fullName: 'Stopped Safely',
    email: 'stopped@capstone.test',
    roles: ['reviewer', 'editor'],
    status: 'failed',
    failureCode: 'BOUNDED_PROVIDER_CLASSIFICATION',
    requestedAt: null,
  },
];

afterEach(() => cleanup());

describe('StaffDirectoryTable', () => {
  it('renders active, pending, zero-role, multi-role and timestamp states semantically', () => {
    render(<StaffDirectoryTable staff={staff} incidents={[]} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Staff directory' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Staff directory' })).toBeDefined();
    expect(screen.getByRole('table', { name: /staff accounts and their assigned roles/i })).toBeDefined();

    const mobileDirectory = screen.getByRole('list', { name: /Admin\/CMS staff accounts/i });
    expect(within(mobileDirectory).getAllByRole('listitem')).toHaveLength(3);
    expect(within(mobileDirectory).getByText(LONG_NAME)).toBeDefined();
    expect(within(mobileDirectory).getByText(LONG_EMAIL)).toBeDefined();
    expect(within(mobileDirectory).getByText('Awaiting account setup')).toBeDefined();
    expect(within(mobileDirectory).getByText('No recognized role')).toBeDefined();
    expect(within(mobileDirectory).getByText('Reviewer')).toBeDefined();
    expect(within(mobileDirectory).getByText('Editor')).toBeDefined();

    const validTime = within(mobileDirectory).getByText(/13 Aug 2026/i);
    expect(validTime.tagName).toBe('TIME');
    expect(validTime.getAttribute('datetime')).toBe('2026-08-13T12:00:00.000Z');
    expect(within(mobileDirectory).getAllByLabelText('Not available')).toHaveLength(2);
  });

  it('retains all three provisioning outcomes with plain-language follow-up context', () => {
    render(<StaffDirectoryTable staff={staff.slice(0, 1)} incidents={incidents} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Provisioning incidents' })).toBeDefined();
    const mobileIncidents = screen.getByRole('list', { name: /Staff provisioning incidents/i });
    expect(within(mobileIncidents).getByText('Cleanup in progress')).toBeDefined();
    expect(within(mobileIncidents).getByText('Needs attention')).toBeDefined();
    expect(within(mobileIncidents).getByText('Stopped safely')).toBeDefined();
    expect(within(mobileIncidents).getByText(/Cleanup is still running/i)).toBeDefined();
    expect(within(mobileIncidents).getByText(/Administrator attention is required/i)).toBeDefined();
    expect(within(mobileIncidents).getByText(/No cleanup action is pending/i)).toBeDefined();
  });

  it('does not expose identifiers, failure detail, secrets, provider data or unsupported actions', () => {
    const unsafeStaff = [{
      ...staff[0],
      authUserId: 'auth-uuid-should-not-render',
      adminUserId: 'profile-uuid-should-not-render',
      invitationToken: 'invitation-secret-should-not-render',
      providerDetail: 'raw-provider-detail-should-not-render',
    }] as unknown as StaffDirectoryEntry[];

    render(<StaffDirectoryTable staff={unsafeStaff} incidents={incidents} />);

    expect(document.body.textContent).not.toContain('auth-uuid-should-not-render');
    expect(document.body.textContent).not.toContain('profile-uuid-should-not-render');
    expect(document.body.textContent).not.toContain('invitation-secret-should-not-render');
    expect(document.body.textContent).not.toContain('raw-provider-detail-should-not-render');
    expect(document.body.textContent).not.toContain('BOUNDED_INTERNAL_FAILURE');
    expect(document.body.textContent).not.toContain('BOUNDED_PROVIDER_CLASSIFICATION');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders a useful empty state without a redundant incident section', () => {
    render(<StaffDirectoryTable staff={[]} incidents={[]} />);

    expect(screen.getByRole('heading', { level: 3, name: 'No staff accounts' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Provisioning incidents' })).toBeNull();
  });
});
