'use client';

import * as React from 'react';
import { AlertDialog as RadixAlertDialog } from 'radix-ui';
import { cn } from '../../lib/utils';
import { buttonVariants } from './button';

/**
 * Locally owned confirmation dialog built on the Radix `AlertDialog` primitive already provided by
 * the `radix-ui` dependency. It replaces native `window.confirm()` for destructive administrative
 * actions so consequences can be stated in full, focus is trapped and restored, and Cancel stays
 * the default focused control. No server-side guard depends on it.
 */

export const AlertDialog = RadixAlertDialog.Root;
export const AlertDialogTrigger = RadixAlertDialog.Trigger;
export const AlertDialogPortal = RadixAlertDialog.Portal;

export const AlertDialogOverlay = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Overlay>,
  React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Overlay>
>(({ className, ...props }, ref) => (
  <RadixAlertDialog.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = RadixAlertDialog.Overlay.displayName;

export const AlertDialogContent = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Content>,
  React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Content>
>(({ className, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <RadixAlertDialog.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-background p-5 shadow-lg sm:p-6 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = RadixAlertDialog.Content.displayName;

export function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2', className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

export const AlertDialogTitle = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Title>,
  React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Title>
>(({ className, ...props }, ref) => (
  <RadixAlertDialog.Title
    ref={ref}
    className={cn('text-base font-semibold tracking-tight text-foreground', className)}
    {...props}
  />
));
AlertDialogTitle.displayName = RadixAlertDialog.Title.displayName;

export const AlertDialogDescription = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Description>,
  React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Description>
>(({ className, ...props }, ref) => (
  <RadixAlertDialog.Description
    ref={ref}
    className={cn('text-sm leading-relaxed text-muted-foreground', className)}
    {...props}
  />
));
AlertDialogDescription.displayName = RadixAlertDialog.Description.displayName;

export const AlertDialogAction = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Action>,
  React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Action> & {
    variant?: 'default' | 'destructive' | 'outline';
  }
>(({ className, variant = 'destructive', ...props }, ref) => (
  <RadixAlertDialog.Action ref={ref} className={cn(buttonVariants({ variant }), className)} {...props} />
));
AlertDialogAction.displayName = RadixAlertDialog.Action.displayName;

export const AlertDialogCancel = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Cancel>,
  React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Cancel>
>(({ className, ...props }, ref) => (
  <RadixAlertDialog.Cancel ref={ref} className={cn(buttonVariants({ variant: 'outline' }), className)} {...props} />
));
AlertDialogCancel.displayName = RadixAlertDialog.Cancel.displayName;
