'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderKanban, FileSpreadsheet, Users, History } from 'lucide-react';
import { NavigationItem, getNavigationItems, getRouteDescriptor } from './navigation';
import { cn } from '../../lib/utils';
import { AppMark } from '../ui/app-mark';

interface SidebarProps {
  onNavClick?: () => void;
  className?: string;
  canManageStaff?: boolean;
}

function getNavIcon(href: string) {
  if (href.startsWith('/admin/imports')) {
    return FileSpreadsheet;
  }
  if (href.startsWith('/admin/staff')) {
    return Users;
  }
  if (href.startsWith('/admin/feed-history')) {
    return History;
  }
  return FolderKanban;
}

export function SidebarNav({ onNavClick, className, canManageStaff = false }: SidebarProps) {
  const pathname = usePathname() || '/admin';
  const activeHref = getRouteDescriptor(pathname).activeHref;
  const navigationItems = getNavigationItems(canManageStaff);

  return (
    <div className={cn('flex flex-col h-full bg-sidebar border-r border-sidebar-border', className)}>
      {/* Brand header */}
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-5 pr-14">
        <AppMark size="sm" />
        <div className="flex flex-col min-w-0">
          <span className="font-bold text-sm leading-tight tracking-tight text-sidebar-foreground truncate">
            Capstone Impact
          </span>
          <span className="text-xs font-medium leading-none text-muted-foreground mt-0.5">
            Admin CMS
          </span>
        </div>
      </div>

      {/* Primary navigation */}
      <nav aria-label="Primary administration" className="flex-1 space-y-1 p-3.5">
        {navigationItems.map((item: NavigationItem) => {
          const Icon = getNavIcon(item.href);
          const isActive = item.href === activeHref;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavClick}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3.5 py-2.5 min-h-[44px] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-muted text-foreground font-semibold border-l-[3px] border-primary shadow-2xs'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
              <span>{item.name}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
