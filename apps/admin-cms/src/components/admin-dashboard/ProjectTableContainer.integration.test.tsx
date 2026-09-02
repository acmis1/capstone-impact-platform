// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ search: '', push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import { ProjectTableContainer } from './ProjectTableContainer';
import { DashboardPreferencesProvider } from './useDashboardPreferences';
import { BulkProjectReviewBusyProvider } from './BulkProjectReviewBusyContext';
import { loadDashboardPreferences } from './dashboardPreferences';
import { parseProjectListQuery } from '../../domain/projectQuery';
import type { ProjectIndexResult, ProjectIndexRow } from './projectDashboardHelpers';

const LONG_TITLE =
  'Synthetic Longitudinal Cross-Disciplinary Capstone Investigation Into Regional Transit Accessibility And Community Wayfinding Outcomes';
const LONG_PUBLIC_ID = 'synthetic-2026-extended-identifier-0001-regional-transit-accessibility';
const LONG_GROUP = 'Synthetic Combined Engineering And Digital Media Collaboration Team Number Fourteen';
const LONG_PARTNER = 'Synthetic Metropolitan Regional Transport And Community Infrastructure Authority';

const baseRow: ProjectIndexRow = {
  id: 'project-1',
  publicId: 'P-1',
  title: 'Atlas',
  status: 'approved',
  program: 'Engineering',
  discipline: 'Software',
  year: '2026',
  groupName: 'Team Atlas',
  industryPartner: 'Synthetic Technology',
  createdAt: '2026-01-01',
  updatedAt: '2026-02-01',
  validationLabel: 'Ready',
  validationVariant: 'success',
};

const result: ProjectIndexResult = {
  rows: [baseRow],
  total: 1,
  page: 1,
  pageSize: 10,
  pageCount: 1,
};

function renderTable(rawSearch = navigation.search, tableResult: ProjectIndexResult = result) {
  navigation.search = rawSearch;
  return render(
    <DashboardPreferencesProvider>
      <ProjectTableContainer
        query={parseProjectListQuery(Object.fromEntries(new URLSearchParams(rawSearch)))}
        result={tableResult}
      />
    </DashboardPreferencesProvider>,
  );
}

async function openColumnsMenu() {
  const trigger = await screen.findByRole('button', { name: /^Columns/ });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.findByRole('menu');
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

  it('persists desktop column visibility through the column settings menu and preserves mandatory columns', async () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy();

    await openColumnsMenu();
    const statusToggle = screen.getByRole('menuitemcheckbox', { name: 'Status' });
    expect(statusToggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(statusToggle);
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull());
    expect(loadDashboardPreferences().visibleColumns).toEqual([
      'title', 'program', 'year', 'validation', 'updatedAt', 'actions',
    ]);

    cleanup();
    renderTable();
    await openColumnsMenu();
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Status' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();

    // Mandatory columns are never offered for removal and never disappear.
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Project' })).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Actions' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Project' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'View project' })).toHaveLength(2);
  });

  it('hides every configurable column while keeping the project and actions columns', async () => {
    renderTable();
    await openColumnsMenu();

    for (const label of ['Status', 'Program & discipline', 'Year', 'Validation', 'Updated']) {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: label }));
    }

    await waitFor(() =>
      expect(screen.queryByRole('columnheader', { name: 'Updated' })).toBeNull(),
    );
    expect(loadDashboardPreferences().visibleColumns).toEqual(['title', 'actions']);
    expect(screen.getByRole('columnheader', { name: 'Project' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'View project' }).length).toBeGreaterThan(0);
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

  it.each([
    ['Project', 'title'],
    ['Status', 'status'],
    ['Year', 'year'],
    ['Updated', 'updated_at'],
  ])('sorts on the %s header and exposes aria-sort for the active column', async (label, field) => {
    renderTable();
    fireEvent.click(await screen.findByRole('button', { name: `Sort by ${label} ascending` }));
    expect(navigation.push).toHaveBeenLastCalledWith(`/admin?sort=${field}&direction=asc`);

    cleanup();
    renderTable(`sort=${field}&direction=asc`);
    expect(screen.getByRole('columnheader', { name: label }).getAttribute('aria-sort')).toBe('ascending');
    // The accessible name always states the direction the next activation applies.
    expect(screen.getByRole('button', { name: `Sort by ${label} descending` })).toBeTruthy();

    cleanup();
    renderTable(`sort=${field}&direction=desc`);
    expect(screen.getByRole('columnheader', { name: label }).getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('button', { name: `Sort by ${label} ascending` })).toBeTruthy();
  });

  it('marks unsorted sortable columns as aria-sort none and leaves static columns unsorted', async () => {
    renderTable('sort=title&direction=asc');
    expect((await screen.findByRole('columnheader', { name: 'Status' })).getAttribute('aria-sort')).toBe('none');
    expect(screen.getByRole('columnheader', { name: 'Year' }).getAttribute('aria-sort')).toBe('none');
    expect(screen.getByRole('columnheader', { name: 'Validation' }).hasAttribute('aria-sort')).toBe(false);
    expect(screen.getByRole('columnheader', { name: 'Program & discipline' }).hasAttribute('aria-sort')).toBe(false);
  });

  it('preserves every active query parameter when changing page and disables boundary controls', async () => {
    const paged: ProjectIndexResult = { rows: [baseRow], total: 120, page: 2, pageSize: 10, pageCount: 12 };
    renderTable('q=atlas&status=approved&year=2026&sort=title&direction=asc&pageSize=10&page=2', paged);

    fireEvent.click(await screen.findByRole('button', { name: 'Go to next page' }));
    expect(navigation.push).toHaveBeenLastCalledWith(
      '/admin?q=atlas&status=approved&year=2026&sort=title&direction=asc&pageSize=10&page=3',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go to previous page' }));
    expect(navigation.push).toHaveBeenLastCalledWith(
      '/admin?q=atlas&status=approved&year=2026&sort=title&direction=asc&pageSize=10&page=1',
    );

    expect(screen.getByText(/Showing/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to previous page' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Go to next page' }).hasAttribute('disabled')).toBe(false);
  });

  it('disables previous on the first page and next on the last page', async () => {
    renderTable('', { rows: [baseRow], total: 30, page: 1, pageSize: 10, pageCount: 3 });
    expect((await screen.findByRole('button', { name: 'Go to previous page' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Go to next page' }).hasAttribute('disabled')).toBe(false);

    cleanup();
    renderTable('page=3', { rows: [baseRow], total: 30, page: 3, pageSize: 10, pageCount: 3 });
    expect((await screen.findByRole('button', { name: 'Go to previous page' })).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Go to next page' }).hasAttribute('disabled')).toBe(true);
  });

  it('reports the current record range and page position', async () => {
    renderTable('page=2&pageSize=25', { rows: [baseRow], total: 128, page: 2, pageSize: 25, pageCount: 6 });
    const range = await screen.findByText(/Showing/);
    expect(range.textContent?.replace(/\s+/g, ' ')).toContain('26');
    expect(range.textContent).toContain('50');
    expect(range.textContent).toContain('128');
    expect(screen.getByText(/^Page/).textContent?.replace(/\s+/g, ' ')).toContain('2');
  });

  it('renders an unavailable state instead of a link when the public ID is missing', async () => {
    renderTable('', {
      rows: [{ ...baseRow, publicId: undefined }],
      total: 1, page: 1, pageSize: 10, pageCount: 1,
    });
    await waitFor(() => expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0));
    expect(screen.queryByRole('link', { name: 'View project' })).toBeNull();
  });

  it('URL-encodes the project detail link', async () => {
    renderTable('', {
      rows: [{ ...baseRow, publicId: 'synthetic 2026/001' }],
      total: 1, page: 1, pageSize: 10, pageCount: 1,
    });
    const links = await screen.findAllByRole('link', { name: 'View project' });
    expect(links[0].getAttribute('href')).toBe('/admin/projects/synthetic%202026%2F001');
  });

  it('renders status and validation as text labels', async () => {
    renderTable('', {
      rows: [
        { ...baseRow, id: 'a', publicId: 'P-A', status: 'in_review', validationLabel: '2 Warnings', validationVariant: 'warning' },
        { ...baseRow, id: 'b', publicId: 'P-B', status: 'changes_requested', validationLabel: '1 Error', validationVariant: 'destructive' },
      ],
      total: 2, page: 1, pageSize: 10, pageCount: 1,
    });

    expect((await screen.findAllByText('In review')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Changes requested').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 Warnings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 Error').length).toBeGreaterThan(0);
  });

  it('renders long titles, public IDs and supporting context in full without truncation markers', async () => {
    renderTable('', {
      rows: [{
        ...baseRow,
        title: LONG_TITLE,
        publicId: LONG_PUBLIC_ID,
        groupName: LONG_GROUP,
        industryPartner: LONG_PARTNER,
      }],
      total: 1, page: 1, pageSize: 10, pageCount: 1,
    });

    expect((await screen.findAllByText(LONG_TITLE)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(LONG_PUBLIC_ID).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(`Group: ${LONG_GROUP} · Partner: ${LONG_PARTNER}`).length,
    ).toBeGreaterThan(0);
  });

  it('preserves the updated-date fallback and the not-recorded state', async () => {
    renderTable('', {
      rows: [
        { ...baseRow, id: 'a', publicId: 'P-A', updatedAt: undefined, createdAt: '2026-03-04T00:00:00.000Z' },
        { ...baseRow, id: 'b', publicId: 'P-B', updatedAt: undefined, createdAt: undefined },
        { ...baseRow, id: 'c', publicId: 'P-C', updatedAt: 'not-a-date', createdAt: undefined },
      ],
      total: 3, page: 1, pageSize: 10, pageCount: 1,
    });

    await waitFor(() => expect(screen.getAllByText('Not recorded').length).toBe(4));
  });

  it('selects individual projects, exposes the selected count, and clears selection', async () => {
    renderTable();
    const rowSelectors = await screen.findAllByRole('checkbox', { name: 'Select Atlas' });
    fireEvent.click(rowSelectors[0]);
    expect(screen.getAllByText('1 selected').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('checkbox', { name: 'Select Atlas' }).some((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
  });

  it('selects every selectable row on the current page and leaves unsafe IDs disabled', async () => {
    renderTable('', {
      rows: [
        baseRow,
        { ...baseRow, id: 'unsafe', publicId: undefined, title: 'Unavailable project' },
      ],
      total: 2, page: 1, pageSize: 10, pageCount: 1,
    });
    const pageSelectors = await screen.findAllByRole('checkbox', { name: 'Select current page' });
    fireEvent.click(pageSelectors[0]);
    expect(screen.getAllByText('1 selected').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('checkbox', { name: 'Project cannot be selected' }).every((checkbox) => (checkbox as HTMLInputElement).disabled)).toBe(true);
  });

  it('selects only the 50 visible projects when the index contains 120 records', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ...baseRow,
      id: `project-${index + 1}`,
      publicId: `release-ui-${String(index + 1).padStart(3, '0')}`,
      title: `Synthetic UI project ${index + 1}`,
    }));
    renderTable('', { rows, total: 120, page: 1, pageSize: 50, pageCount: 3 });

    fireEvent.click((await screen.findAllByRole('checkbox', { name: 'Select current page' }))[0]);

    await waitFor(() => expect(screen.getAllByText('50 selected').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('checkbox', { name: /Select Synthetic UI project/ }).filter((checkbox) => (checkbox as HTMLInputElement).checked)).toHaveLength(50);
  });

  it('moves from page one to page two and never carries hidden page-one selection forward', async () => {
    const pageOneRows = [
      { ...baseRow, id: 'page-one-a', publicId: 'release-page-one-a', title: 'Page one project A' },
      { ...baseRow, id: 'page-one-b', publicId: 'release-page-one-b', title: 'Page one project B' },
    ];
    const pageTwoRows = [
      { ...baseRow, id: 'page-two-a', publicId: 'release-page-two-a', title: 'Page two project A' },
      { ...baseRow, id: 'page-two-b', publicId: 'release-page-two-b', title: 'Page two project B' },
    ];
    const pageOne: ProjectIndexResult = { rows: pageOneRows, total: 120, page: 1, pageSize: 50, pageCount: 3 };
    const pageTwo: ProjectIndexResult = { rows: pageTwoRows, total: 120, page: 2, pageSize: 50, pageCount: 3 };
    const view = renderTable('', pageOne);

    fireEvent.click((await screen.findAllByRole('checkbox', { name: 'Select current page' }))[0]);
    await waitFor(() => expect(screen.getAllByText('2 selected').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(navigation.push).toHaveBeenLastCalledWith('/admin?page=2');

    navigation.search = 'page=2';
    view.rerender(
      <DashboardPreferencesProvider>
        <ProjectTableContainer
          query={parseProjectListQuery({ page: '2' })}
          result={pageTwo}
        />
      </DashboardPreferencesProvider>,
    );

    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Page two project A', level: 4 })).toBeTruthy();
    expect(screen.queryByText('Page one project A')).toBeNull();
    expect(screen.getAllByRole('checkbox', { name: 'Select Page two project A' }).every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
  });

  it.each([
    ['search', 'q=atlas'],
    ['filter', 'status=approved'],
    ['sort', 'sort=title&direction=asc'],
    ['pagination', 'page=2'],
    ['page size', 'pageSize=25'],
  ])('clears selection when the %s query scope changes', async (_label, nextSearch) => {
    const view = renderTable();
    fireEvent.click((await screen.findAllByRole('checkbox', { name: 'Select Atlas' }))[0]);
    expect(screen.getAllByText('1 selected').length).toBeGreaterThan(0);

    navigation.search = nextSearch;
    view.rerender(
      <DashboardPreferencesProvider>
        <ProjectTableContainer
          query={parseProjectListQuery(Object.fromEntries(new URLSearchParams(nextSearch)))}
          result={result}
        />
      </DashboardPreferencesProvider>,
    );

    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
  });
});

describe('ProjectTableContainer mobile card presentation', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    navigation.search = '';
    navigation.push.mockReset();
    navigation.replace.mockReset();
  });

  afterEach(cleanup);

  it('keeps every critical project field and the view action in the mobile card', async () => {
    renderTable();
    const card = (await screen.findByRole('heading', { name: 'Atlas', level: 4 })).closest('li');
    expect(card).toBeTruthy();

    const cardQueries = within(card as HTMLElement);
    expect(cardQueries.getByText('P-1')).toBeTruthy();
    expect(cardQueries.getByText('Approved')).toBeTruthy();
    expect(cardQueries.getByText('Ready')).toBeTruthy();
    expect(cardQueries.getByText('Engineering')).toBeTruthy();
    expect(cardQueries.getByText('Software')).toBeTruthy();
    expect(cardQueries.getByText('2026')).toBeTruthy();
    expect(cardQueries.getByText('Group: Team Atlas · Partner: Synthetic Technology')).toBeTruthy();
    expect(cardQueries.getByText('Updated')).toBeTruthy();
    expect(cardQueries.getByRole('link', { name: 'View project' })).toBeTruthy();
  });

  it('keeps mobile card content intact when every configurable desktop column is hidden', async () => {
    renderTable();
    await openColumnsMenu();
    for (const label of ['Status', 'Program & discipline', 'Year', 'Validation', 'Updated']) {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: label }));
    }
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Year' })).toBeNull());

    const card = screen.getByRole('heading', { name: 'Atlas', level: 4 }).closest('li');
    const cardQueries = within(card as HTMLElement);
    expect(cardQueries.getByText('Approved')).toBeTruthy();
    expect(cardQueries.getByText('Ready')).toBeTruthy();
    expect(cardQueries.getByText('Engineering')).toBeTruthy();
    expect(cardQueries.getByText('2026')).toBeTruthy();
    expect(cardQueries.getByRole('link', { name: 'View project' })).toBeTruthy();
  });

  it('selects a project from the mobile card controls', async () => {
    renderTable();
    const card = (await screen.findByRole('heading', { name: 'Atlas', level: 4 })).closest('li');
    fireEvent.click(within(card as HTMLElement).getByRole('checkbox', { name: 'Select project' }));
    expect(screen.getAllByText('1 selected').length).toBeGreaterThan(0);
  });

  it('disables selection, sorting, pagination, and bulk actions while a preflight is in flight', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(pending);
    render(
      <DashboardPreferencesProvider>
        <BulkProjectReviewBusyProvider>
          <ProjectTableContainer query={parseProjectListQuery({})} result={result} canReviewBulk />
        </BulkProjectReviewBusyProvider>
      </DashboardPreferencesProvider>,
    );
    fireEvent.click((await screen.findAllByRole('checkbox', { name: 'Select Atlas' }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox', { name: 'Select Atlas' }).every((input) => (input as HTMLInputElement).disabled)).toBe(true);
      expect((screen.getByRole('button', { name: 'Clear selection' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Sort by Project ascending' }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveRequest?.(new Response(JSON.stringify({ action: 'approve', summary: { total: 1, eligible: 0, blocked: 1, alreadyComplete: 0, invalidOrStale: 0 }, items: [] }), { status: 200 }));
  });
});
