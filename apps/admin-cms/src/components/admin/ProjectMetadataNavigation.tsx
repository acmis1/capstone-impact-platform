'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';

/**
 * Outcome of asking the metadata editor to adopt an assistive title suggestion.
 *
 * - `applied`      the editor draft now holds the suggested title;
 * - `cancelled`    a human was asked to confirm a replacement and declined (or dismissed);
 * - `unavailable`  no editable metadata editor is mounted, so nothing could be applied.
 *
 * A caller must never report success for `cancelled` or `unavailable`. When confirmation is
 * required the promise stays pending until the human decides, so "confirmation pending" can
 * never be mistaken for "applied".
 */
export type TitleSuggestionOutcome = 'applied' | 'cancelled' | 'unavailable';

export type TitleSuggestionHandler = (title: string) => Promise<'applied' | 'cancelled'>;

interface NavigationContextValue {
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  registerTitleSuggestionHandler: (handler: TitleSuggestionHandler | null) => void;
  canApplyTitleSuggestion: boolean;
  applyTitleSuggestion: (title: string) => Promise<TitleSuggestionOutcome>;
}

const MetadataNavigationContext = createContext<NavigationContextValue | null>(null);

export function ProjectMetadataNavigationProvider({ children }: { children: React.ReactNode }) {
  const [dirty, setDirty] = useState(false);
  const [canApplyTitleSuggestion, setCanApplyTitleSuggestion] = useState(false);
  const titleHandlerRef = useRef<TitleSuggestionHandler | null>(null);

  // Browser-native protection stays for actual browser/tab/window unload only. In-app navigation
  // is guarded by the accessible AlertDialog below, never by window.confirm.
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const registerTitleSuggestionHandler = useCallback((handler: TitleSuggestionHandler | null) => {
    titleHandlerRef.current = handler;
    setCanApplyTitleSuggestion(handler !== null);
  }, []);

  const applyTitleSuggestion = useCallback(async (title: string): Promise<TitleSuggestionOutcome> => {
    const handler = titleHandlerRef.current;
    if (!handler) return 'unavailable';
    return handler(title);
  }, []);

  const value = useMemo(() => ({
    dirty,
    setDirty,
    registerTitleSuggestionHandler,
    canApplyTitleSuggestion,
    applyTitleSuggestion,
  }), [dirty, registerTitleSuggestionHandler, canApplyTitleSuggestion, applyTitleSuggestion]);

  return <MetadataNavigationContext.Provider value={value}>{children}</MetadataNavigationContext.Provider>;
}

export function useProjectMetadataNavigation() {
  const context = useContext(MetadataNavigationContext);
  if (!context) throw new Error('ProjectMetadataNavigationProvider is required.');
  return context;
}

export function GuardedProjectBackLink({
  href,
  children,
  className,
  style,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const { dirty, setDirty } = useProjectMetadataNavigation();
  const [showConfirm, setShowConfirm] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement>(null);

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!dirty) return;
    event.preventDefault();
    setShowConfirm(true);
  };

  const handleDiscard = () => {
    setShowConfirm(false);
    // Clearing the dirty flag before navigating keeps the beforeunload handler from adding a
    // second, browser-native prompt on top of the choice the user just made here.
    setDirty(false);
    router.push(href);
  };

  return (
    <>
      <Link ref={triggerRef} href={href} className={className} style={style} onClick={handleClick}>
        {children}
      </Link>
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in project information. If you leave now, your edits will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowConfirm(false)}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDiscard}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
