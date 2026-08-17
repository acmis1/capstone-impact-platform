'use client';

import * as React from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export const Sheet = RadixDialog.Root;
export const SheetTrigger = RadixDialog.Trigger;
export const SheetClose = RadixDialog.Close;
export const SheetPortal = RadixDialog.Portal;

export const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Overlay>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(({ className, ...props }, ref) => (
  <RadixDialog.Overlay
    className={cn(
      'fixed inset-0 z-50 bg-black/50 backdrop-blur-xs transition-opacity data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = RadixDialog.Overlay.displayName;

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Content>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
    side?: 'left' | 'right';
  }
>(({ side = 'left', className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <RadixDialog.Content
      ref={ref}
      className={cn(
        'fixed z-50 flex flex-col bg-background shadow-xl transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-300 inset-y-0 w-72 max-w-sm',
        side === 'left'
          ? 'left-0 border-r border-border data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left'
          : 'right-0 border-l border-border data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
        className
      )}
      {...props}
    >
      {children}
      <RadixDialog.Close className="absolute right-3 top-3.5 z-10 rounded-md p-1.5 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-[40px] min-w-[40px] flex items-center justify-center">
        <X className="h-5 w-5" aria-hidden="true" />
        <span className="sr-only">Close navigation drawer</span>
      </RadixDialog.Close>
    </RadixDialog.Content>
  </SheetPortal>
));
SheetContent.displayName = RadixDialog.Content.displayName;

export const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-2 text-left', className)} {...props} />
);
SheetHeader.displayName = 'SheetHeader';

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Title>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(({ className, ...props }, ref) => (
  <RadixDialog.Title
    ref={ref}
    className={cn('text-lg font-semibold text-foreground', className)}
    {...props}
  />
));
SheetTitle.displayName = RadixDialog.Title.displayName;

export const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Description>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(({ className, ...props }, ref) => (
  <RadixDialog.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = RadixDialog.Description.displayName;
