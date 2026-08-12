// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ search: '', push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import { ProjectTableContainer } from './ProjectTableContainer';
import { DashboardPreferencesProvider } from './useDashboardPreferences';
import { loadDashboardPreferences } from './dashboardPreferences';
import { parseProjectListQuery } from '../../domain/projectQuery';

const result = {
  rows: [{
    id: 'project-1', publicId: 'P-1', title: 'Atlas', status: 'approved' as const,
    program: 'Engineering', discipline: 'Software', year: '2026',
    createdAt: '2026-01-01', updatedAt: '2026-02-01', validationLabel: 'Ready', validationVariant: 'success' as const,
  }],
  total: 1, page: 1, pageSize: 10, pageCount: 1,
};

function renderTable(rawSearch = navigation.search) {
  navigation.search = rawSearch;
  return render(
    <DashboardPreferencesProvider>
      <ProjectTableContainer query={parseProjectListQuery(Object.fromEntries(new URLSearchParams(rawSearch)))} result={result} />
    </DashboardPreferencesProvider>,
  );
}

describe('ProjectTableContainer preference integration', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    navigation.search = '';
    navigation.push.mockReset();
    navigation.replace.mockReset();
  });

  afterEach(cleanup);

  it('persists desktop column visibility and preserves mandatory title and actions columns', async () => {
    renderTable();
    const statusToggle = await screen.findByRole('checkbox', { name: 'Status' });
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy();

    fireEvent.click(statusToggle);
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull());
    expect(loadDashboardPreferences().visibleColumns).toEqual([
      'title', 'program', 'year', 'validation', 'updatedAt', 'actions',
    ]);

    cleanup();
    renderTable();
    expect((await screen.findByRole('checkbox', { name: 'Status' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Project' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'View project' })).toHaveLength(2);
  });

  it('persists both sort and direction from the actual table interaction', async () => {
    renderTable();
    fireEvent.click(await screen.findByRole('button', { name: 'Sort by Project ascending' }));

    expect(navigation.push).toHaveBeenCalledWith('/admin?sort=title&direction=asc');
    expect(loadDashboardPreferences()).toMatchObject({ sort: 'title', direction: 'asc' });

    navigation.search = 'sort=title&direction=asc';
    cleanup();
    renderTable(navigation.search);
    fireEvent.click(await screen.findByRole('button', { name: 'Sort by Project descending' }));
    expect(navigation.push).toHaveBeenLastCalledWith('/admin?sort=title&direction=desc');
    expect(loadDashboardPreferences()).toMatchObject({ sort: 'title', direction: 'desc' });
  });
});
