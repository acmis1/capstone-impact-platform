// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  DEFAULT_DASHBOARD_PREFERENCES,
  DASHBOARD_PREFERENCES_KEY,
  loadDashboardPreferences,
  saveDashboardPreferences,
  resetDashboardPreferences,
} from './dashboardPreferences';

describe('dashboardPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns default preferences when nothing is stored', () => {
    const preferences = loadDashboardPreferences();

    expect(preferences).toEqual(DEFAULT_DASHBOARD_PREFERENCES);
  });

  it('saves and restores dashboard preferences', () => {
    const preferences = {
      ...DEFAULT_DASHBOARD_PREFERENCES,
      pageSize: 25 as const,
      sort: 'title' as const,
      direction: 'asc' as const,
      status: 'approved' as const,
      program: 'Computer Science',
      discipline: 'Software Engineering',
      year: '2026',
      visibleColumns: ['title', 'status', 'year'],
    };

    saveDashboardPreferences(preferences);

    expect(localStorage.getItem(DASHBOARD_PREFERENCES_KEY)).not.toBeNull();

    expect(loadDashboardPreferences()).toEqual(preferences);
  });

  it('resets preferences back to defaults', () => {
    const preferences = {
      ...DEFAULT_DASHBOARD_PREFERENCES,
      pageSize: 50 as const,
      sort: 'title' as const,
      direction: 'asc' as const,
    };

    saveDashboardPreferences(preferences);

    resetDashboardPreferences();

    expect(loadDashboardPreferences()).toEqual(
      DEFAULT_DASHBOARD_PREFERENCES,
    );
  });

  it('ignores corrupted JSON and returns defaults', () => {
    localStorage.setItem(
      DASHBOARD_PREFERENCES_KEY,
      '{invalid-json',
    );

    expect(loadDashboardPreferences()).toEqual(
      DEFAULT_DASHBOARD_PREFERENCES,
    );
  });

  it('ignores an unsupported storage version', () => {
    localStorage.setItem(
      DASHBOARD_PREFERENCES_KEY,
      JSON.stringify({
        version: 999,
        preferences: {
          ...DEFAULT_DASHBOARD_PREFERENCES,
          pageSize: 50,
        },
      }),
    );

    expect(loadDashboardPreferences()).toEqual(
      DEFAULT_DASHBOARD_PREFERENCES,
    );
  });

  it('repairs invalid stored preference values', () => {
    localStorage.setItem(
      DASHBOARD_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        preferences: {
          ...DEFAULT_DASHBOARD_PREFERENCES,
          pageSize: 999,
          sort: 'invalid-sort',
          direction: 'invalid-direction',
          status: 'invalid-status',
          visibleColumns: 'not-an-array',
        },
      }),
    );

    const preferences = loadDashboardPreferences();

    expect(preferences.pageSize).toBe(
      DEFAULT_DASHBOARD_PREFERENCES.pageSize,
    );

    expect(preferences.sort).toBe(
      DEFAULT_DASHBOARD_PREFERENCES.sort,
    );

    expect(preferences.direction).toBe(
      DEFAULT_DASHBOARD_PREFERENCES.direction,
    );

    expect(preferences.status).toBe(
      DEFAULT_DASHBOARD_PREFERENCES.status,
    );

    expect(preferences.visibleColumns).toEqual(
      DEFAULT_DASHBOARD_PREFERENCES.visibleColumns,
    );
  });

  it('does not throw when localStorage is unavailable', () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('Storage unavailable');
      });

    expect(() => loadDashboardPreferences()).not.toThrow();

    expect(getItemSpy).toHaveBeenCalled();
  });

  it('does not throw when saving fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    expect(() =>
      saveDashboardPreferences(DEFAULT_DASHBOARD_PREFERENCES),
    ).not.toThrow();
  });
});