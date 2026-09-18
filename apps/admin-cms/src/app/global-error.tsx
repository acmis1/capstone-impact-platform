'use client';

import './globals.css';
import { ApplicationRecovery } from '../components/auth/ApplicationRecovery';

export default function GlobalError({ retry }: { error: unknown; retry: () => void; reset?: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ApplicationRecovery retry={retry} />
      </body>
    </html>
  );
}
