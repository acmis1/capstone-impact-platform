// @vitest-environment jsdom

import * as React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ search: '', push: vi.fn(), replace: vi.fn() }));

const repository = vi.hoisted(() => ({
  listProjectsPage: vi.fn(),
  getProjectDashboardMetrics: vi.fn(),
  getProjectFilterOptions: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock('../../repositories/SupabaseProjectRepository', () => ({
  SupabaseProjectRepository: class {
    listProjectsPage = repository.listProjectsPage;
    getProjectDashboardMetrics = repository.getProjectDashboardMetrics;
    getProjectFilterOptions = repository.getProjectFilterOptions;
  },
}));

vi.mock('../../auth/requireAdmin', () => ({
  requireAdmin: vi.fn(async () => ({ permissions: ['projects.edit'] })),
}));

import { requireAdmin } from '../../auth/requireAdmin';
import AdminPage from '../../app/admin/page';
import Loading from '../../app/admin/loading';
import { DashboardMetricsSummary } from './DashboardMetricsSummary';
import { NoMatchingProjectsState } from './NoMatchingProjectsState';
import { DashboardPreferencesProvider } from './useDashboardPreferences';
import { loadDashboardPreferences, saveDashboardPreferences, DEFAULT_DASHBOARD_PREFERENCES } from './dashboardPreferences';
import { parseProjectListQuery } from '../../domain/projectQuery';

const EMPTY_OPTIONS = { years: [], programs: [], disciplines: [] };

async function renderAdminPage(params: Record<string, string> = {}) {
  navigation.search = new URLSearchParams(params).toString();
  const element = await AdminPage({ searchParams: Promise.resolve(params) });
  return render(element);
}

describe('DashboardMetricsSummary', () => {
  afterEach(cleanup);

  it('renders the exact metric definitions with their values', () => {
    render(
      <DashboardMetricsSummary
        metrics={{ totalProjects: 128, publicEligible: 34, inReview: 7, archived: 12 }}
      />,
    );

    const pairs: Array<[string, string, string]> = [
      ['Total projects', '128', 'All non-deleted project records'],
      ['Approved or published', '34', 'Projects that have reached approved or published workflow status'],
      ['In review', '7', 'Projects with In review status'],
      ['Archived', '12', 'Projects with Archived status'],
    ];

    for (const [label, value, description] of pairs) {
      const term = screen.getByText(label);
      const item = term.closest('div')?.parentElement as HTMLElement;
      expect(within(item).getByText(value)).toBeTruthy();
      expect(within(item).getByText(description)).toBeTruthy();
    }
  });

  it('states that the counts are not filtered results', () => {
    render(
      <DashboardMetricsSummary
        metrics={{ totalProjects: 1, publicEligible: 0, inReview: 0, archived: 0 }}
      />,
    );
    expect(
      screen.getByText(
        'Summary counts cover all non-deleted project records and do not change with search or filters.',
      ),
    ).toBeTruthy();
  });

  it('exposes the metrics as a semantic list in a compact two-by-two mobile grid with dividers', () => {
    const { container } = render(
      <DashboardMetricsSummary
        metrics={{ totalProjects: 128, publicEligible: 34, inReview: 7, archived: 12 }}
      />,
    );

    const grid = screen.getByRole('list');

    expect(container.querySelector('section')?.className).toContain('border-border-structural');
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).toContain('lg:grid-cols-4');

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);

    // Every metric stays a single list item carrying its own label, value and description.
    const expected: Array<[string, string, string]> = [
      ['Total projects', '128', 'All non-deleted project records'],
      ['Approved or published', '34', 'Projects that have reached approved or published workflow status'],
      ['In review', '7', 'Projects with In review status'],
      ['Archived', '12', 'Projects with Archived status'],
    ];

    expected.forEach(([label, value, description], index) => {
      expect(within(items[index]).getByText(label)).toBeTruthy();
      expect(within(items[index]).getByText(value)).toBeTruthy();
      expect(within(items[index]).getByText(description)).toBeTruthy();
    });

    // The remediated defect was `<dt>`/`<dd>` sitting two levels below the `<dl>`, so they formed
    // no definition-list group. This guards that shape without forbidding a future valid `<dl>`.
    for (const term of container.querySelectorAll('dt, dd')) {
      const parent = term.parentElement;
      const inList = parent?.tagName === 'DL';
      const inGroup = parent?.tagName === 'DIV' && parent.parentElement?.tagName === 'DL';
      expect(inList || inGroup).toBe(true);
    }

    expect(items[1].className).toContain('border-l');
    expect(items[2].className).toContain('border-t');
    expect(items[2].className).toContain('lg:border-t-0 lg:border-l');
    expect(items[3].className).toContain('border-t border-l');
    expect(items[3].className).toContain('lg:border-t-0');

    for (const item of items) {
      expect(item.className).toContain('border-border');
    }

    expect(screen.getByText(/Summary counts cover/).className).toContain('border-border');
  });

  it('uses structural boundaries only for Projects outer surfaces while retaining internal semantic dividers', () => {
    const filterBarSource = fs.readFileSync(path.resolve(__dirname, './ProjectFilterBar.tsx'), 'utf-8');
    const tableSource = fs.readFileSync(path.resolve(__dirname, './ProjectTableContainer.tsx'), 'utf-8');

    expect(filterBarSource).toContain('STRUCTURAL_SURFACE_CLASS_NAME');
    expect(filterBarSource).toContain('border-t border-border pt-4');
    expect(filterBarSource).toContain('border-t border-border bg-surface-inset');
    expect(tableSource).toContain('rounded-xl border border-border-structural bg-card shadow-xs md:block');
    expect(tableSource).toContain('rounded-xl border border-border-structural bg-card px-4 py-3 shadow-xs');
    expect(tableSource).toContain('border-b border-border bg-muted/40');
    expect(tableSource).toContain('divide-y divide-border');
    expect(tableSource).toContain('rounded-lg border border-border bg-card p-4');
  });

  it('calls the project identifier a project ID in staff-facing search copy', () => {
    const filterBarSource = fs.readFileSync(path.resolve(__dirname, './ProjectFilterBar.tsx'), 'utf-8');

    expect(filterBarSource).toContain('Search by title, project ID, partner, or group...');
    expect(filterBarSource).toContain('Matches project title, project ID, industry partner and group name.');
    expect(filterBarSource).not.toContain('public ID');
    expect(filterBarSource).not.toContain('Public ID');
  });
});

describe('NoMatchingProjectsState', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    navigation.search = '';
    navigation.push.mockReset();
  });

  afterEach(cleanup);

  it('names the active search and filter context without implying missing data', () => {
    navigation.search = 'q=atlas&status=approved&year=2026';
    render(
      <DashboardPreferencesProvider>
        <NoMatchingProjectsState
          query={parseProjectListQuery({ q: 'atlas', status: 'approved', year: '2026' })}
        />
      </DashboardPreferencesProvider>,
    );

    expect(screen.getByText('No projects match your search or filters')).toBeTruthy();
    expect(
      screen.getByText(
        'No project records match search "atlas", status Approved, year 2026. Adjust or remove a filter to widen the results.',
      ),
    ).toBeTruthy();
  });

  it('clears search and filters while preserving sort, direction and page size', () => {
    saveDashboardPreferences({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      status: 'approved',
      year: '2026',
      pageSize: 50,
      sort: 'title',
      direction: 'asc',
      visibleColumns: ['title', 'status', 'actions'],
    });
    navigation.search = 'q=atlas&status=approved&year=2026&sort=title&direction=asc&pageSize=50&page=3';

    render(
      <DashboardPreferencesProvider>
        <NoMatchingProjectsState
          query={parseProjectListQuery({ q: 'atlas', status: 'approved', year: '2026' })}
        />
      </DashboardPreferencesProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));

    expect(navigation.push).toHaveBeenCalledWith('/admin?sort=title&direction=asc&pageSize=50');
    expect(loadDashboardPreferences()).toMatchObject({
      status: '',
      year: '',
      program: '',
      discipline: '',
      pageSize: 50,
      sort: 'title',
      direction: 'asc',
      visibleColumns: ['title', 'status', 'actions'],
    });
  });
});

describe('Projects index route loading state', () => {
  afterEach(cleanup);

  it('exposes an accessible loading status and renders no placeholder metric values', () => {
    const { container } = render(<Loading />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading project records.');
    expect(container.textContent).toBe('Loading project records.');
  });
});

describe('Projects index page states', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    navigation.search = '';
    navigation.push.mockReset();
    navigation.replace.mockReset();
    repository.listProjectsPage.mockReset();
    repository.getProjectDashboardMetrics.mockReset();
    repository.getProjectFilterOptions.mockReset();
  });

  afterEach(cleanup);

  it('shows the no-records state when the repository holds no projects', async () => {
    repository.listProjectsPage.mockResolvedValue({ projects: [], total: 0, page: 1, pageSize: 10, pageCount: 0 });
    repository.getProjectDashboardMetrics.mockResolvedValue({ totalProjects: 0, publicEligible: 0, inReview: 0, archived: 0 });
    repository.getProjectFilterOptions.mockResolvedValue(EMPTY_OPTIONS);

    await renderAdminPage();

    expect(screen.getByText('No project records available')).toBeTruthy();
    expect(
      screen.getByText(
        'There are currently no active capstone project records stored in the staging database repository.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('No projects match your search or filters')).toBeNull();
  });

  it('shows the filtered no-results state, kept distinct from the no-records state', async () => {
    repository.listProjectsPage.mockResolvedValue({ projects: [], total: 0, page: 1, pageSize: 10, pageCount: 0 });
    repository.getProjectDashboardMetrics.mockResolvedValue({ totalProjects: 128, publicEligible: 34, inReview: 7, archived: 12 });
    repository.getProjectFilterOptions.mockResolvedValue({ years: ['2026'], programs: [], disciplines: [] });

    await renderAdminPage({ q: 'atlas' });

    expect(screen.getByText('No projects match your search or filters')).toBeTruthy();
    expect(screen.queryByText('No project records available')).toBeNull();
    // Global metrics are still shown, and remain global rather than filtered counts.
    expect(screen.getByText('128')).toBeTruthy();
  });

  it('presents a bounded load error without exposing the database failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    repository.listProjectsPage.mockRejectedValue(new Error('connection to 10.0.0.5:5432 refused: password authentication failed'));
    repository.getProjectDashboardMetrics.mockResolvedValue({ totalProjects: 0, publicEligible: 0, inReview: 0, archived: 0 });
    repository.getProjectFilterOptions.mockResolvedValue(EMPTY_OPTIONS);

    const { container } = await renderAdminPage();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Projects could not be loaded')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reload page' })).toBeTruthy();
    expect(container.textContent).not.toContain('password authentication failed');
    expect(container.textContent).not.toContain('10.0.0.5');

    consoleError.mockRestore();
  });

  it('only offers the contextual import action to staff who hold the edit permission', async () => {
    repository.listProjectsPage.mockResolvedValue({ projects: [], total: 0, page: 1, pageSize: 10, pageCount: 0 });
    repository.getProjectDashboardMetrics.mockResolvedValue({ totalProjects: 0, publicEligible: 0, inReview: 0, archived: 0 });
    repository.getProjectFilterOptions.mockResolvedValue(EMPTY_OPTIONS);

    await renderAdminPage();
    expect(screen.getAllByRole('link', { name: 'New import' }).length).toBeGreaterThan(0);

    cleanup();
    vi.mocked(requireAdmin).mockResolvedValueOnce({
      permissions: ['projects.review'],
    } as Awaited<ReturnType<typeof requireAdmin>>);

    await renderAdminPage();
    expect(screen.queryByRole('link', { name: 'New import' })).toBeNull();
  });

  it('reports the current result context in the page header', async () => {
    repository.listProjectsPage.mockResolvedValue({ projects: [], total: 128, page: 1, pageSize: 10, pageCount: 13 });
    repository.getProjectDashboardMetrics.mockResolvedValue({ totalProjects: 128, publicEligible: 34, inReview: 7, archived: 12 });
    repository.getProjectFilterOptions.mockResolvedValue(EMPTY_OPTIONS);

    await renderAdminPage();
    expect(screen.getByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy();
    expect(screen.getByText('128 project records')).toBeTruthy();

    cleanup();
    repository.listProjectsPage.mockResolvedValue({ projects: [], total: 3, page: 1, pageSize: 10, pageCount: 1 });
    await renderAdminPage({ q: 'atlas' });
    expect(screen.getByText('3 matching project records')).toBeTruthy();
  });
});
