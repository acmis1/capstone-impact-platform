'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export interface LanguageDraftSuggestion {
  field: 'title' | 'summary' | 'background' | 'solution';
  startOffset: number;
  endOffset: number;
  offsetUnit: 'UNICODE_CODE_POINTS';
  originalSourceSpan: string;
  replacement: string;
}

interface NavigationContextValue {
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  confirmDiscard: () => boolean;
  registerTitleSuggestionHandler: (handler: ((title: string) => boolean) | null) => void;
  canApplyTitleSuggestion: boolean;
  applyTitleSuggestion: (title: string) => boolean;
  registerLanguageSuggestionHandler: (handler: ((suggestion: LanguageDraftSuggestion) => boolean) | null) => void;
  canApplyLanguageSuggestion: boolean;
  applyLanguageSuggestion: (suggestion: LanguageDraftSuggestion) => boolean;
}

const MetadataNavigationContext = createContext<NavigationContextValue | null>(null);

export function ProjectMetadataNavigationProvider({ children }: { children: React.ReactNode }) {
  const [dirty, setDirty] = useState(false);
  const [canApplyTitleSuggestion, setCanApplyTitleSuggestion] = useState(false);
  const titleHandlerRef = useRef<((title: string) => boolean) | null>(null);
  const [canApplyLanguageSuggestion, setCanApplyLanguageSuggestion] = useState(false);
  const languageHandlerRef = useRef<((suggestion: LanguageDraftSuggestion) => boolean) | null>(null);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const registerTitleSuggestionHandler = useCallback((handler: ((title: string) => boolean) | null) => {
    titleHandlerRef.current = handler;
    setCanApplyTitleSuggestion(handler !== null);
  }, []);

  const applyTitleSuggestion = useCallback((title: string) => {
    if (!titleHandlerRef.current) return false;
    return titleHandlerRef.current(title);
  }, []);

  const registerLanguageSuggestionHandler = useCallback((handler: ((suggestion: LanguageDraftSuggestion) => boolean) | null) => {
    languageHandlerRef.current = handler;
    setCanApplyLanguageSuggestion(handler !== null);
  }, []);

  const applyLanguageSuggestion = useCallback((suggestion: LanguageDraftSuggestion) => {
    if (!languageHandlerRef.current) return false;
    return languageHandlerRef.current(suggestion);
  }, []);

  const value = useMemo(() => ({
    dirty,
    setDirty,
    confirmDiscard: () => !dirty || window.confirm('Discard your unsaved metadata changes?'),
    registerTitleSuggestionHandler,
    canApplyTitleSuggestion,
    applyTitleSuggestion,
    registerLanguageSuggestionHandler,
    canApplyLanguageSuggestion,
    applyLanguageSuggestion,
  }), [
    dirty, registerTitleSuggestionHandler, canApplyTitleSuggestion, applyTitleSuggestion,
    registerLanguageSuggestionHandler, canApplyLanguageSuggestion, applyLanguageSuggestion,
  ]);

  return <MetadataNavigationContext.Provider value={value}>{children}</MetadataNavigationContext.Provider>;
}

export function useProjectMetadataNavigation() {
  const context = useContext(MetadataNavigationContext);
  if (!context) throw new Error('ProjectMetadataNavigationProvider is required.');
  return context;
}

export function GuardedProjectBackLink({ href, children, className, style }: { href: string; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const { confirmDiscard } = useProjectMetadataNavigation();
  return <Link href={href} className={className} style={style} onClick={(event) => { if (!confirmDiscard()) event.preventDefault(); }}>{children}</Link>;
}
