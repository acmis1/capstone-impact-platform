import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthError } from '../../auth/authTypes';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  repositoryConstructed: vi.fn(),
  listProjectsPage: vi.fn(),
  getProjectDashboardMetrics: vi.fn(),
  getProjectFilterOptions: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../../auth/requireAdmin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../../repositories/SupabaseProjectRepository', () => ({
  SupabaseProjectRepository: class {
    constructor() {
      mocks.repositoryConstructed();
    }
    listProjectsPage = mocks.listProjectsPage;
    getProjectDashboardMetrics = mocks.getProjectDashboardMetrics;
    getProjectFilterOptions = mocks.getProjectFilterOptions;
  },
}));

// The filter bar is a Client Component bound to the App Router. This suite exercises the page's
// server-side authorization boundary, so the interactive surface is stubbed rather than mounted.
vi.mock('../../components/admin-dashboard/ProjectFilterBar', () => ({
  ProjectFilterBar: () => null,
}));

import AdminPage from './page';

const AUTHORIZED_CONTEXT = {
  adminUserId: '11111111-1111-4111-8111-111111111111',
  authUserId: '22222222-2222-4222-8222-222222222222',
  email: 'reviewer@example.invalid',
  fullName: 'Synthetic Reviewer',
  roles: ['reviewer'],
  permissions: ['projects.view', 'projects.review'],
};

function emptySearchParams() {
  return Promise.resolve({} as Record<string, string | string[] | undefined>);
}

async function renderAdminPage() {
  const element = await AdminPage({ searchParams: emptySearchParams() });
  return renderToStaticMarkup(element as React.ReactElement);
}

describe('Admin projects page authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectsPage.mockResolvedValue({
      projects: [],
      total: 0,
      page: 1,
      pageSize: 25,
      pageCount: 1,
    });
    mocks.getProjectDashboardMetrics.mockResolvedValue({
      totalProjects: 0,
      publicEligible: 0,
      inReview: 0,
      archived: 0,
    });
    mocks.getProjectFilterOptions.mockResolvedValue({ years: [], programs: [], disciplines: [] });
  });

  it.each([
    ['UNAUTHENTICATED', 'Authentication is required.'],
    ['PERMISSION_DENIED', 'Administrative access is not available for this account.'],
    ['AUTHENTICATION_PROVENANCE_INVALID', 'Authentication cannot be used for administrative access.'],
    ['CONFIGURATION_FAILURE', 'Authentication service unavailable.'],
  ])(
    'reads no project data through the service-role repository when authorization fails with %s',
    async (type, message) => {
      mocks.requireAdmin.mockRejectedValueOnce(
        new AdminAuthError(type as ConstructorParameters<typeof AdminAuthError>[0], message),
      );

      const markup = await renderAdminPage();

      expect(mocks.repositoryConstructed).not.toHaveBeenCalled();
      expect(mocks.listProjectsPage).not.toHaveBeenCalled();
      expect(mocks.getProjectDashboardMetrics).not.toHaveBeenCalled();
      expect(mocks.getProjectFilterOptions).not.toHaveBeenCalled();
      expect(markup).toContain('Projects are unavailable');
      expect(markup).not.toContain('New import');
    },
  );

  it('fails closed for a revoked session even when the underlying failure is not an AdminAuthError', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error('session revoked'));

    const markup = await renderAdminPage();

    expect(mocks.repositoryConstructed).not.toHaveBeenCalled();
    expect(mocks.listProjectsPage).not.toHaveBeenCalled();
    expect(markup).toContain('Projects are unavailable');
  });

  it('never leaks the underlying authorization failure detail to the rendered page', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new AdminAuthError('CONFIGURATION_FAILURE', 'SUPABASE_SERVICE_ROLE_KEY is missing'),
    );

    const markup = await renderAdminPage();

    expect(markup).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(markup).not.toContain('service_role');
  });

  it('still loads project data for an authorized administrative session', async () => {
    mocks.requireAdmin.mockResolvedValueOnce(AUTHORIZED_CONTEXT);

    const markup = await renderAdminPage();

    expect(mocks.repositoryConstructed).toHaveBeenCalledTimes(1);
    expect(mocks.listProjectsPage).toHaveBeenCalledTimes(1);
    expect(mocks.getProjectDashboardMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.getProjectFilterOptions).toHaveBeenCalledTimes(1);
    expect(markup).not.toContain('Projects are unavailable');
    expect(markup).toContain('No project records available');
  });
});
