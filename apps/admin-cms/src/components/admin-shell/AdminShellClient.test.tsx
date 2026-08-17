// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: '/admin',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AdminShellClient } from './AdminShellClient';
import { SidebarNav } from './SidebarNav';
import { TopBar } from './TopBar';
import { EnvironmentNotice } from './EnvironmentNotice';
import { AuthErrorScreen } from './AuthErrorScreen';

describe('Admin Shell and Layout Components', () => {
  const logoutMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = '/admin';
  });

  afterEach(() => {
    cleanup();
  });

  describe('AdminShellClient', () => {
    it('renders skip link targeting #admin-main-content', () => {
      render(
        <AdminShellClient
          displayName="Test Admin"
          email="admin@rmit.edu.au"
          roles={['admin']}
          canManageStaff={true}
          logoutAction={logoutMock}
        >
          <div>Child Content</div>
        </AdminShellClient>
      );

      const skipLink = screen.getByRole('link', { name: /Skip to main content/i });
      expect(skipLink).toBeDefined();
      expect(skipLink.getAttribute('href')).toBe('#admin-main-content');
    });

    it('renders polite live status announcement landmark', () => {
      const { container } = render(
        <AdminShellClient
          displayName="Test Admin"
          email="admin@rmit.edu.au"
          roles={['admin']}
          logoutAction={logoutMock}
        >
          <div>Content</div>
        </AdminShellClient>
      );

      const liveRegion = container.querySelector('#admin-status-announcement');
      expect(liveRegion).not.toBeNull();
      expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
      expect(liveRegion?.getAttribute('aria-atomic')).toBe('true');
    });

    it('renders main content container with id admin-main-content', () => {
      render(
        <AdminShellClient
          displayName="Test Admin"
          email="admin@rmit.edu.au"
          roles={['admin']}
          logoutAction={logoutMock}
        >
          <div data-testid="test-child">Child Element</div>
        </AdminShellClient>
      );

      const main = screen.getByRole('main');
      expect(main.id).toBe('admin-main-content');
      expect(screen.getByTestId('test-child')).toBeDefined();
    });
  });

  describe('SidebarNav', () => {
    it('renders core navigation items with aria-current on active route', () => {
      mocks.pathname = '/admin';
      render(<SidebarNav canManageStaff={false} />);

      const projectsLink = screen.getByRole('link', { name: /Projects/i });
      const importsLink = screen.getByRole('link', { name: /Imports/i });

      expect(projectsLink.getAttribute('aria-current')).toBe('page');
      expect(importsLink.getAttribute('aria-current')).toBeNull();
      expect(screen.queryByRole('link', { name: /Staff access/i })).toBeNull();
    });

    it('shows Staff access link only when canManageStaff is true', () => {
      mocks.pathname = '/admin/staff';
      render(<SidebarNav canManageStaff={true} />);

      const staffLink = screen.getByRole('link', { name: /Staff access/i });
      expect(staffLink).toBeDefined();
      expect(staffLink.getAttribute('aria-current')).toBe('page');
    });

    it('fires onNavClick callback when link is clicked', () => {
      const onNavClick = vi.fn();
      render(<SidebarNav canManageStaff={false} onNavClick={onNavClick} />);

      const importsLink = screen.getByRole('link', { name: /Imports/i });
      fireEvent.click(importsLink);
      expect(onNavClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('TopBar', () => {
    it('displays user identity, roles, and staging badge', () => {
      render(
        <TopBar
          displayName="Jane Doe"
          email="jane@rmit.edu.au"
          roles={['admin', 'reviewer']}
          canManageStaff={true}
          logoutAction={logoutMock}
        />
      );

      expect(screen.getByText('Jane Doe')).toBeDefined();
      expect(screen.getByText('ADMIN, REVIEWER')).toBeDefined();
      expect(screen.getByText(/STAGING/i)).toBeDefined();
      expect(screen.getByRole('button', { name: /Open main navigation menu/i })).toBeDefined();
    });

    it('renders account trigger with accessible label and user details', () => {
      render(
        <TopBar
          displayName="Jane Doe"
          email="jane@rmit.edu.au"
          roles={['admin']}
          canManageStaff={true}
          logoutAction={logoutMock}
        />
      );

      const accountBtn = screen.getByRole('button', { name: /Open account menu for Jane Doe/i });
      expect(accountBtn).toBeDefined();
      expect(accountBtn.getAttribute('aria-haspopup')).toBe('menu');
    });
  });

  describe('EnvironmentNotice', () => {
    it('renders exact staging disclaimer text', () => {
      render(<EnvironmentNotice />);
      expect(screen.getByRole('region', { name: /Environment notice/i })).toBeDefined();
      expect(
        screen.getByText(/Work here uses staging data and does not update the public showcase website\./i)
      ).toBeDefined();
    });
  });

  describe('AuthErrorScreen', () => {
    it('renders heading, message, and sign out form', () => {
      render(
        <AuthErrorScreen
          heading="Access Denied"
          message="You do not have permission to manage staff access."
          logoutAction={logoutMock}
        />
      );

      expect(screen.getByRole('heading', { level: 1, name: 'Access Denied' })).toBeDefined();
      expect(screen.getByText('You do not have permission to manage staff access.')).toBeDefined();
      expect(screen.getByRole('button', { name: /Sign Out/i })).toBeDefined();
    });
  });
});
