'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { runtimeEnvironmentLabel, type RuntimeDisplayEnvironment } from '../../domain/institution';

const RuntimeEnvironmentContext = createContext<RuntimeDisplayEnvironment>('unconfigured');

/** Receives a non-sensitive, allowlisted label from the server root; never browser-derived authority. */
export function RuntimeEnvironmentPresentation({ environment, children }: {
  environment: RuntimeDisplayEnvironment;
  children: ReactNode;
}) {
  return <RuntimeEnvironmentContext.Provider value={environment}>{children}</RuntimeEnvironmentContext.Provider>;
}

export function AuthEnvironmentBadge() {
  const environment = useContext(RuntimeEnvironmentContext);
  return (
    <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-foreground">
      {runtimeEnvironmentLabel(environment)}
    </span>
  );
}
