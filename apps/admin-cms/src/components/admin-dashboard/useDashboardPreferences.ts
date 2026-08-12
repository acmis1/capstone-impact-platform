'use client';

import * as React from 'react';

import {
  DEFAULT_DASHBOARD_PREFERENCES,
  loadDashboardPreferences,
  resetDashboardPreferences as clearStoredDashboardPreferences,
  saveDashboardPreferences,
  validateDashboardPreferences,
  type DashboardPreferences,
} from './dashboardPreferences';

interface DashboardPreferencesContextValue {
  preferences: DashboardPreferences;
  updatePreferences(updates: Partial<DashboardPreferences>): void;
  resetPreferences(): void;
  isLoaded: boolean;
}

const DashboardPreferencesContext = React.createContext<DashboardPreferencesContextValue | null>(null);

export function DashboardPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = React.useState<DashboardPreferences>(DEFAULT_DASHBOARD_PREFERENCES);
  const [isLoaded, setIsLoaded] = React.useState(false);

  React.useEffect(() => {
    // Browser storage is deliberately read only after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferences(loadDashboardPreferences());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoaded(true);
  }, []);

  const updatePreferences = React.useCallback((updates: Partial<DashboardPreferences>) => {
    setPreferences((current) => {
      const next = validateDashboardPreferences({ ...current, ...updates });
      saveDashboardPreferences(next);
      return next;
    });
  }, []);

  const resetPreferences = React.useCallback(() => {
    const defaults = clearStoredDashboardPreferences();
    setPreferences(defaults);
  }, []);

  return React.createElement(
    DashboardPreferencesContext.Provider,
    { value: { preferences, updatePreferences, resetPreferences, isLoaded } },
    children,
  );
}

export function useDashboardPreferences(): DashboardPreferencesContextValue {
  const value = React.useContext(DashboardPreferencesContext);
  if (!value) throw new Error('Dashboard preferences must be used within DashboardPreferencesProvider.');
  return value;
}
