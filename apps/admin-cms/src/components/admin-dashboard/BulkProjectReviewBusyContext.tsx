'use client';

import * as React from 'react';

interface BulkProjectReviewBusyContextValue {
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

const BulkProjectReviewBusyContext = React.createContext<BulkProjectReviewBusyContextValue>({
  busy: false,
  setBusy: () => undefined,
});

export function BulkProjectReviewBusyProvider({ children }: { children: React.ReactNode }) {
  const [busy, setBusy] = React.useState(false);
  const value = React.useMemo(() => ({ busy, setBusy }), [busy]);
  return <BulkProjectReviewBusyContext.Provider value={value}>{children}</BulkProjectReviewBusyContext.Provider>;
}

export function useBulkProjectReviewBusy(): BulkProjectReviewBusyContextValue {
  return React.useContext(BulkProjectReviewBusyContext);
}
