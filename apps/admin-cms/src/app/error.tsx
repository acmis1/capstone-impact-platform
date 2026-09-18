'use client';

import { ApplicationRecovery } from '../components/auth/ApplicationRecovery';

/** Never render/log raw exceptions: they can contain private operational values. */
export default function ErrorPage({ retry }: { error: unknown; retry: () => void; reset?: () => void }) {
  return <ApplicationRecovery retry={retry} />;
}
