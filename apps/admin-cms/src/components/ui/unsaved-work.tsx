'use client';

import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

export interface UnsavedWorkActionOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: 'default' | 'destructive' | 'outline';
  forceConfirmation?: boolean;
  trigger?: HTMLElement | null;
}

interface PendingAction {
  run: () => void;
  trigger: HTMLElement | null;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant: 'default' | 'destructive' | 'outline';
}

export function useUnsavedWorkGuard({
  dirty,
  onDiscard,
  navigate,
  guardDocumentNavigation = true,
}: {
  dirty: boolean;
  onDiscard: () => void;
  navigate?: (href: string) => void;
  guardDocumentNavigation?: boolean;
}) {
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const restoreFocusRef = React.useRef(true);
  const restoreTargetRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const requestAction = React.useCallback((run: () => void, options: UnsavedWorkActionOptions = {}) => {
    const mustConfirm = dirty || options.forceConfirmation === true;
    if (!mustConfirm) {
      run();
      return;
    }
    const trigger = options.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    restoreTargetRef.current = trigger;
    setPending({
      run,
      trigger,
      title: options.title ?? 'Discard unsaved changes?',
      description: options.description ?? 'You have unsaved changes. If you continue, your edits will be lost.',
      confirmLabel: options.confirmLabel ?? 'Discard changes',
      confirmVariant: options.confirmVariant ?? 'destructive',
    });
  }, [dirty]);

  const handleCancel = React.useCallback(() => {
    setPending(null);
  }, []);

  const handleDiscard = React.useCallback(() => {
    const action = pending;
    if (!action) return;
    restoreFocusRef.current = false;
    restoreTargetRef.current = null;
    setPending(null);
    onDiscard();
    action.run();
  }, [onDiscard, pending]);

  React.useEffect(() => {
    if (!guardDocumentNavigation || !navigate || !dirty) return;

    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest('a');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download') || anchor.getAttribute('aria-disabled') === 'true') return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      let destination: URL;
      try {
        destination = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search &&
        destination.hash
      ) return;

      event.preventDefault();
      event.stopPropagation();
      const destinationHref = `${destination.pathname}${destination.search}${destination.hash}`;
      requestAction(
        () => navigate(destinationHref),
        { trigger: anchor },
      );
    };

    document.addEventListener('click', guardLink, true);
    return () => document.removeEventListener('click', guardLink, true);
  }, [dirty, guardDocumentNavigation, navigate, requestAction]);

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) handleCancel(); }}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (restoreFocusRef.current) {
            event.preventDefault();
            restoreTargetRef.current?.focus();
          }
          restoreFocusRef.current = true;
          restoreTargetRef.current = null;
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title ?? 'Discard unsaved changes?'}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.description ?? ''}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleCancel}>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant={pending?.confirmVariant ?? 'destructive'} onClick={handleDiscard}>
            {pending?.confirmLabel ?? 'Discard changes'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { requestAction, dialog, isDialogOpen: pending !== null };
}
