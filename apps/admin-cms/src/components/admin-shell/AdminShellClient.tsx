'use client';

import * as React from 'react';
import { SidebarNav } from './SidebarNav';
import { TopBar } from './TopBar';

export interface AdminShellClientProps {
  displayName?: string | null;
  email?: string | null;
  roles?: string[];
  logoutAction: () => Promise<void>;
  children: React.ReactNode;
}

export function AdminShellClient({
  displayName,
  email,
  roles = [],
  logoutAction,
  children,
}: AdminShellClientProps) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      {/* Skip to main content link */}
      <a
        href="#admin-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-primary focus:outline-none focus:ring-2 focus:ring-ring"
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
          <SidebarNav className="h-full sticky top-0" />
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar
            displayName={displayName}
            email={email}
            roles={roles}
            logoutAction={logoutAction}
          />

          <main
            id="admin-main-content"
            tabIndex={-1}
            className="flex-1 p-4 lg:p-6 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
