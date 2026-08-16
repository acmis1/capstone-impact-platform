'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderKanban, FileSpreadsheet, Users } from 'lucide-react';
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
  return FolderKanban;
}

export function SidebarNav({ onNavClick, className, canManageStaff = false }: SidebarProps) {
  const pathname = usePathname() || '/admin';
  const activeHref = getRouteDescriptor(pathname).activeHref;
  const navigationItems = getNavigationItems(canManageStaff);

  return (
    <div className={cn('flex flex-col h-full bg-background border-r', className)}>
      {/* Brand header */}
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <AppMark size="sm" />
        <div className="flex flex-col min-w-0">
          <span className="font-bold text-sm leading-tight tracking-tight text-foreground truncate">
            Capstone Impact
          </span>
          <span className="text-[11px] font-medium leading-none text-muted-foreground">
            Admin
          </span>
        </div>
      </div>

      {/* Primary navigation */}
      <nav aria-label="Primary administration" className="flex-1 space-y-1 p-3">
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
                'flex items-center gap-3 rounded-md px-3 py-2.5 min-h-[44px] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-primary/10 text-primary border-l-2 border-primary font-semibold'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{item.name}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
