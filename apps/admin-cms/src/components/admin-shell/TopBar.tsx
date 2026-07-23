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
  logoutAction: () => Promise<void>;
}

export function TopBar({ displayName, email, roles = [], logoutAction }: UserSummaryProps) {
  const pathname = usePathname() || '/admin';
  const descriptor = getRouteDescriptor(pathname);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const identityLabel = displayName || email || 'Administrator';
  const formattedRoles = roles.map((r) => r.toUpperCase()).join(', ');

  return (
    <header className="sticky top-0 z-40 flex h-16 w-full items-center justify-between border-b bg-background/95 px-4 backdrop-blur-xs lg:px-6">
      <div className="flex items-center gap-3">
        {/* Mobile Navigation Drawer Trigger */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <IconButton
              variant="outline"
              size="sm"
              aria-label="Open main navigation menu"
              className="lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </IconButton>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-72">
            <SheetHeader className="sr-only">
              <SheetTitle>Admin Navigation</SheetTitle>
              <SheetDescription>
                Main navigation drawer for administrative sections.
              </SheetDescription>
            </SheetHeader>
            <SidebarNav onNavClick={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>

        {/* Route-aware breadcrumbs and title */}
        <div className="flex flex-col justify-center">
          <Breadcrumbs items={descriptor.breadcrumbs} />
          <h1 className="text-base font-semibold tracking-tight text-foreground">
            {descriptor.title}
          </h1>
        </div>
      </div>

      {/* Top bar right utilities */}
      <div className="flex items-center gap-3">
        {/* Environment Badge */}
        <Badge variant="neutral" className="hidden sm:inline-flex text-xs font-semibold uppercase tracking-wider">
          Staging
        </Badge>

        {/* Account Dropdown Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 px-2 focus-visible:ring-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                <User className="h-4 w-4" />
              </div>
              <div className="hidden md:flex flex-col text-left">
                <span className="text-xs font-semibold leading-tight text-foreground">
                  {identityLabel}
                </span>
                {formattedRoles && (
                  <span className="text-[10px] text-muted-foreground leading-tight">
                    {formattedRoles}
                  </span>
                )}
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-semibold leading-none text-foreground">
                  {identityLabel}
                </p>
                {email && (
                  <p className="text-xs leading-none text-muted-foreground">
                    {email}
                  </p>
                )}
                {formattedRoles && (
                  <p className="text-[11px] font-medium text-primary pt-1">
                    Role: {formattedRoles}
                  </p>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <form action={logoutAction} className="w-full">
                <button
                  type="submit"
                  className="flex w-full items-center gap-2 text-destructive focus:text-destructive cursor-pointer"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Log out</span>
                </button>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
