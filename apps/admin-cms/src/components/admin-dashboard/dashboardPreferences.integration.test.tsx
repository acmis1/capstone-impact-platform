// @vitest-environment jsdom

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

import { ProjectFilterBar } from './ProjectFilterBar';
import {
  DASHBOARD_PREFERENCES_KEY,
  DEFAULT_DASHBOARD_PREFERENCES,
  loadDashboardPreferences,
  saveDashboardPreferences,
} from './dashboardPreferences';
import {
  DashboardPreferencesProvider,
  useDashboardPreferences,
} from './useDashboardPreferences';
import { parseProjectListQuery } from '../../domain/projectQuery';

const filterOptions = {
  availableYears: ['2025', '2026'],
  availablePrograms: ['Engineering', 'Science'],
  availableDisciplines: ['Software', 'Data'],
};

function renderFilterBar(rawSearch = navigation.search) {
  navigation.search = rawSearch;
  return render(
    <DashboardPreferencesProvider>
      <ProjectFilterBar query={parseProjectListQuery(Object.fromEntries(new URLSearchParams(rawSearch)))} {...filterOptions} />
    </DashboardPreferencesProvider>,
  );
}

function PreferenceProbe({ id }: { id: string }) {
  const { preferences, updatePreferences, resetPreferences, isLoaded } = useDashboardPreferences();
  return (
    <div>
      <output data-testid={`${id}-page-size`}>{isLoaded ? preferences.pageSize : 'loading'}</output>
      <button type="button" onClick={() => updatePreferences({ pageSize: 50 })}>set size</button>
      <button type="button" onClick={resetPreferences}>reset state</button>
    </div>
  );
}

describe('dashboard preference production integration', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    navigation.search = '';
    navigation.push.mockReset();
    navigation.replace.mockReset();
  });

  afterEach(cleanup);

  it('shares a hydrated preference state and reset between consumers without overwriting stored values', async () => {
    saveDashboardPreferences({ ...DEFAULT_DASHBOARD_PREFERENCES, pageSize: 25 });

    render(
      <DashboardPreferencesProvider>
        <PreferenceProbe id="first" />
        <PreferenceProbe id="second" />
      </DashboardPreferencesProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('first-page-size').textContent).toBe('25'));
    expect(screen.getByTestId('second-page-size').textContent).toBe('25');
    expect(loadDashboardPreferences().pageSize).toBe(25);

    fireEvent.click(screen.getAllByRole('button', { name: 'set size' })[0]);
    expect(screen.getByTestId('second-page-size').textContent).toBe('50');
    expect(loadDashboardPreferences().pageSize).toBe(50);

    fireEvent.click(screen.getAllByRole('button', { name: 'reset state' })[0]);
    expect(screen.getByTestId('first-page-size').textContent).toBe('10');
    expect(localStorage.getItem(DASHBOARD_PREFERENCES_KEY)).toBeNull();
  });

  it('uses raw URL presence so explicit values beat stored values and partial URLs restore only absent fields', async () => {
    saveDashboardPreferences({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      status: 'approved',
      pageSize: 50,
      sort: 'title',
      direction: 'asc',
    });

    renderFilterBar('status=draft&pageSize=10&sort=year');

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/admin?status=draft&pageSize=10&sort=year&direction=asc'));
    expect(navigation.replace).toHaveBeenCalledTimes(1);

    navigation.search = 'status=draft&pageSize=10&sort=year&direction=asc';
    renderFilterBar(navigation.search);
    await act(async () => {});
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it('restores absent stored values, repairs stale filters, and keeps malformed explicit values authoritative', async () => {
    saveDashboardPreferences({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      status: 'approved',
      year: '2022',
      program: 'Retired program',
      discipline: 'Retired discipline',
      pageSize: 50,
    });

    renderFilterBar('pageSize=999');

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/admin?pageSize=10&status=approved'));
    expect(loadDashboardPreferences()).toMatchObject({
      year: '',
      program: '',
      discipline: '',
      pageSize: 50,
    });
  });

  it('clears persisted filters and URL filters while preserving sort, direction, page size, and columns', async () => {
    saveDashboardPreferences({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      status: 'approved',
      year: '2026',
      program: 'Engineering',
      discipline: 'Software',
      pageSize: 50,
      sort: 'title',
      direction: 'asc',
      visibleColumns: ['title', 'status', 'actions'],
    });

    renderFilterBar('q=capstone&status=approved&year=2026&program=Engineering&discipline=Software&pageSize=50&sort=title&direction=asc&page=3');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(navigation.push).toHaveBeenCalledWith('/admin?pageSize=50&sort=title&direction=asc');
    expect(loadDashboardPreferences()).toMatchObject({
      status: '', year: '', program: '', discipline: '', pageSize: 50, sort: 'title', direction: 'asc',
    });
  });

  it('resets persisted preferences while preserving transient search and clearing page and preference parameters', async () => {
    saveDashboardPreferences({ ...DEFAULT_DASHBOARD_PREFERENCES, status: 'approved', pageSize: 50, sort: 'title', direction: 'asc' });
    renderFilterBar('q=capstone&status=approved&pageSize=50&sort=title&direction=asc&page=4');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset preferences' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Reset preferences' }));

    expect(navigation.push).toHaveBeenCalledWith('/admin?q=capstone');
    expect(localStorage.getItem(DASHBOARD_PREFERENCES_KEY)).toBeNull();
  });
});
