import type { ReactNode } from 'react';
import { LegacyRecoveryBridge } from './LegacyRecoveryBridge';

export default function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LegacyRecoveryBridge />
      {children}
    </>
  );
}
