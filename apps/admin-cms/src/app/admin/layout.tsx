import React from 'react';
import { requireAdmin } from '../../auth/requireAdmin';
import { logoutAction } from '../login/actions';
import { redirect } from 'next/navigation';
import { AdminAuthError } from '../../auth/authTypes';
import { getPublicAuthErrorMessage } from '../../auth/authHttp';
import { AdminShellClient } from '../../components/admin-shell/AdminShellClient';
import { AuthErrorScreen } from '../../components/admin-shell/AuthErrorScreen';

/**
 * Server Component layout serving as authorization guard for all administrative sub-pages.
 * 
 * Rules:
 * - Enforces session requirements and admin role provisioning before children render.
 * - Displays the current administrator's credentials and assigned roles.
 * - Provides a server action trigger to handle secure logouts.
 * - Maps all authorization/connection errors to generic, production-safe messages using design system components.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let adminContext;
  try {
    adminContext = await requireAdmin();
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      if (error.type === 'UNAUTHENTICATED') {
        redirect('/login?redirectTo=/admin');
      }

      const publicMessage = getPublicAuthErrorMessage(error.type);
      const isConfigFailure = error.type === 'CONFIGURATION_FAILURE';
      const heading = isConfigFailure ? 'Service Outage' : 'Access Denied';

      // Safe error screen for unprovisioned/unauthorized authenticated identities
      return (
        <AuthErrorScreen
          heading={heading}
          message={publicMessage}
          logoutAction={logoutAction}
          isConfigFailure={isConfigFailure}
        />
      );
    }

    // Default safety fallback for unknown exceptions
    const publicMessage = getPublicAuthErrorMessage('UNKNOWN');
    return (
      <AuthErrorScreen
        heading="System Error"
        message={publicMessage}
        logoutAction={logoutAction}
      />
    );
  }

  return (
    <AdminShellClient
      displayName={adminContext.fullName}
      email={adminContext.email}
      roles={adminContext.roles}
      logoutAction={logoutAction}
    >
      {children}
    </AdminShellClient>
  );
}
