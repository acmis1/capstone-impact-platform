// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  canManageStaff: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({ bounded: true })),
  readStaffDirectory: vi.fn(),
  isStaffProvisioningEnabled: vi.fn(),
  isVerifiedStagingRuntime: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../../auth/permissions', () => ({ canManageStaff: mocks.canManageStaff }));
vi.mock('../../../lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock('../../../staff/staffDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../staff/staffDirectory')>();
  return { ...actual, readStaffDirectory: mocks.readStaffDirectory };
});
vi.mock('../../../staff/staffProvisioningEnablement', () => ({
  isStaffProvisioningEnabled: mocks.isStaffProvisioningEnabled,
}));
vi.mock('../../../security/stagingRuntimeIdentity', () => ({
  isVerifiedStagingRuntime: mocks.isVerifiedStagingRuntime,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import StaffAccessPage from './page';

const DIRECTORY = {
  staff: [
    {
      fullName: 'Synthetic Administrator',
      email: 'administrator@capstone.test',
      roles: ['admin' as const],
      status: 'active' as const,
      requestedAt: '2026-08-13T12:00:00.000Z',
    },
    {
      fullName: 'Pending Reviewer',
      email: 'pending@capstone.test',
      roles: ['reviewer' as const],
      status: 'pending_activation' as const,
      requestedAt: '2026-08-14T12:00:00.000Z',
    },
  ],
  incidents: [
    {
      fullName: 'Needs Attention',
      email: 'attention@capstone.test',
      roles: ['editor' as const],
      status: 'compensation_failed' as const,
      failureCode: null,
      requestedAt: '2026-08-15T12:00:00.000Z',
    },
  ],
};

describe('StaffAccessPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      adminUserId: 'bounded-admin-id',
      permissions: ['projects.read', 'staff.manage'],
    });
    mocks.canManageStaff.mockReturnValue(true);
    mocks.readStaffDirectory.mockResolvedValue(DIRECTORY);
    mocks.isStaffProvisioningEnabled.mockReturnValue(true);
    mocks.isVerifiedStagingRuntime.mockReturnValue(false);
  });

  afterEach(() => cleanup());

  it('renders authorized context and keeps the directory ahead of access-creation actions', async () => {
    render(await StaffAccessPage());

    expect(screen.getAllByRole('heading', { level: 1, name: 'Staff access' })).toHaveLength(1);
    expect(screen.getByText(/Review who can use the Admin\/CMS/i)).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('Invitations available')).toBeDefined();

    const directory = screen.getByRole('region', { name: 'Staff directory' });
    const actionsHeading = screen.getByRole('heading', { level: 2, name: 'Access creation' });
    expect(directory.compareDocumentPosition(actionsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mocks.canManageStaff).toHaveBeenCalledWith(['projects.read', 'staff.manage']);
  });

  it('keeps the server-side permission check authoritative on direct navigation', async () => {
    mocks.canManageStaff.mockReturnValue(false);
    render(await StaffAccessPage());

    expect(screen.getByRole('heading', { level: 2, name: 'Access denied' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Staff directory' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send invitation/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Create test account/i })).toBeNull();
    expect(document.body.textContent).not.toContain('administrator@capstone.test');
    expect(mocks.readStaffDirectory).not.toHaveBeenCalled();
  });

  it('fails soft when the directory cannot load while leaving authorized actions independent', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.readStaffDirectory.mockRejectedValue(new Error('raw provider detail'));
    render(await StaffAccessPage());

    expect(screen.getByRole('heading', { level: 2, name: 'Staff directory unavailable' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDefined();
    expect(document.body.textContent).not.toContain('raw provider detail');
    expect(consoleError).toHaveBeenCalledWith('[Staff Access Page]: STAFF_DIRECTORY_READ_FAILED');
    consoleError.mockRestore();
  });

  it('shows a bounded invitation-unavailable state without hiding the directory', async () => {
    mocks.isStaffProvisioningEnabled.mockReturnValue(false);
    mocks.isVerifiedStagingRuntime.mockReturnValue(true);
    render(await StaffAccessPage());

    expect(screen.getByRole('region', { name: 'Staff directory' })).toBeDefined();
    expect(screen.getByText('Invitations paused')).toBeDefined();
    expect(screen.getByText('Invitations are unavailable')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Create test account' })).toBeNull();
  });

  it('renders the test-account form only when both server-resolved conditions are true', async () => {
    mocks.isVerifiedStagingRuntime.mockReturnValue(true);
    render(await StaffAccessPage());

    expect(screen.getByRole('heading', { name: 'Create test account' })).toBeDefined();
    expect(screen.getByText('Staging only')).toBeDefined();
  });
});
