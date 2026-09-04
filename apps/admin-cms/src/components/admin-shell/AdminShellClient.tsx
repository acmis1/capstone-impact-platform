'use client';

import * as React from 'react';
import { SidebarNav } from './SidebarNav';
import { TopBar } from './TopBar';
import { EnvironmentNotice } from './EnvironmentNotice';

export interface AdminShellClientProps {
  displayName?: string | null;
  email?: string | null;
  roles?: string[];
  canManageStaff?: boolean;
  logoutAction: () => Promise<void>;
  children: React.ReactNode;
}

export function AdminShellClient({
  displayName,
  email,
  roles = [],
  canManageStaff = false,
  logoutAction,
  children,
}: AdminShellClientProps) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      {/* Skip to main content link */}
      <a
        href="#admin-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-2 focus:bg-background focus:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:shadow-md rounded-md font-semibold text-sm"
      >
        Skip to main content
      </a>

      {/* Global polite live status announcement region */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="admin-status-announcement"
      />

      <div className="flex flex-1 min-h-screen">
        {/* Desktop Persistent Sidebar */}
        <aside className="hidden lg:block w-64 shrink-0">
          <SidebarNav className="h-full sticky top-0" canManageStaff={canManageStaff} />
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar
            displayName={displayName}
            email={email}
            roles={roles}
            canManageStaff={canManageStaff}
            logoutAction={logoutAction}
          />

          <EnvironmentNotice />

          <main
            id="admin-main-content"
            tabIndex={-1}
            className="flex-1 p-4 sm:p-6 lg:p-8 outline-none focus-visible:ring-1 focus-visible:ring-ring w-full max-w-[1920px] mx-auto"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
