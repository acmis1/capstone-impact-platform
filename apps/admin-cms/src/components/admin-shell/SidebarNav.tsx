'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderKanban, FileSpreadsheet } from 'lucide-react';
import { NAVIGATION_ITEMS, NavigationItem, getRouteDescriptor } from './navigation';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';

interface SidebarProps {
  onNavClick?: () => void;
  className?: string;
}

function getNavIcon(href: string) {
  if (href.startsWith('/admin/imports')) {
    return FileSpreadsheet;
  }
  return FolderKanban;
}

export function SidebarNav({ onNavClick, className }: SidebarProps) {
  const pathname = usePathname() || '/admin';
  const activeHref = getRouteDescriptor(pathname).activeHref;

  return (
    <div className={cn('flex flex-col h-full bg-background border-r', className)}>
      {/* Brand header */}
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <span className="font-extrabold text-base tracking-wider text-primary">
          RMIT CAPSTONE
        </span>
        <span className="text-muted-foreground/40 font-light">|</span>
        <span className="text-xs font-semibold text-muted-foreground">Admin</span>
      </div>

      {/* Primary navigation */}
      <nav aria-label="Primary administration" className="flex-1 space-y-1 p-3">
        {NAVIGATION_ITEMS.map((item: NavigationItem) => {
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

      {/* Footer environment label */}
      <div className="border-t p-4 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Environment</span>
        <Badge variant="neutral" className="text-xs font-semibold uppercase">
          Staging
        </Badge>
      </div>
    </div>
  );
}
