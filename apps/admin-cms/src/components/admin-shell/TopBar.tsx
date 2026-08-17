'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Menu, LogOut, User } from 'lucide-react';
import { getRouteDescriptor } from './navigation';
import { Breadcrumbs } from './Breadcrumbs';
import { SidebarNav } from './SidebarNav';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { IconButton } from '../ui/icon-button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '../ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export interface UserSummaryProps {
  displayName?: string | null;
  email?: string | null;
  roles?: string[];
  canManageStaff?: boolean;
  logoutAction: () => Promise<void>;
}

export function TopBar({ displayName, email, roles = [], canManageStaff = false, logoutAction }: UserSummaryProps) {
  const pathname = usePathname() || '/admin';
  const descriptor = getRouteDescriptor(pathname);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const identityLabel = displayName || email || 'Administrator';
  const formattedRoles = roles.map((r) => r.toUpperCase()).join(', ');

  return (
    <header className="sticky top-0 z-40 flex h-16 w-full items-center justify-between border-b border-border/80 bg-background/95 px-4 lg:px-6 backdrop-blur-xs gap-3 min-w-0">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Mobile Navigation Drawer Trigger */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <IconButton
              variant="outline"
              size="sm"
              aria-label="Open main navigation menu"
              className="lg:hidden min-h-[44px] min-w-[44px] shrink-0"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </IconButton>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-72">
            <SheetHeader className="sr-only">
              <SheetTitle>Admin Navigation</SheetTitle>
              <SheetDescription>
                Main navigation drawer for administrative sections.
              </SheetDescription>
            </SheetHeader>
            <SidebarNav onNavClick={() => setMobileOpen(false)} canManageStaff={canManageStaff} />
          </SheetContent>
        </Sheet>

        {/* Route-aware breadcrumbs and title */}
        <div className="flex flex-col justify-center min-w-0 flex-1 gap-0.5">
          <Breadcrumbs items={descriptor.breadcrumbs} />
          <h1 className="text-sm sm:text-base font-semibold tracking-tight text-foreground truncate">
            {descriptor.title}
          </h1>
        </div>
      </div>

      {/* Top bar right utilities */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Environment Badge */}
        <Badge variant="neutral" className="inline-flex px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider border border-border/80 bg-muted/80 text-foreground">
          Staging
        </Badge>

        {/* Account Dropdown Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Open account menu for ${identityLabel}`}
              className="gap-2.5 px-2.5 hover:bg-muted/80 focus-visible:ring-2 min-h-[44px] rounded-lg"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted border border-border/60 text-foreground">
                <User className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="hidden md:flex flex-col text-left">
                <span className="text-xs font-semibold leading-tight text-foreground truncate max-w-[160px]">
                  {identityLabel}
                </span>
                {formattedRoles && (
                  <span className="text-[11px] text-muted-foreground font-medium leading-tight mt-0.5">
                    {formattedRoles}
                  </span>
                )}
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="font-normal p-3">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-semibold leading-none text-foreground">
                  {identityLabel}
                </p>
                {email && (
                  <p className="text-xs leading-none text-muted-foreground pt-0.5">
                    {email}
                  </p>
                )}
                {formattedRoles && (
                  <p className="text-xs font-medium text-foreground-subtle pt-1.5">
                    Role: <span className="font-semibold text-foreground">{formattedRoles}</span>
                  </p>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async (e) => {
                e.preventDefault();
                await logoutAction();
              }}
              className="flex w-full items-center gap-2.5 text-destructive focus:text-destructive cursor-pointer min-h-[44px] px-3 py-2 font-medium"
            >
              <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
