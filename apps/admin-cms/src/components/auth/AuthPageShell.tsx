import type { ReactNode } from 'react';
import { AppMark } from '../ui/app-mark';
import { Card } from '../ui/card';

export function AuthPageShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6 lg:px-12">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-5xl flex-col">
        <header className="flex items-center justify-between pb-8 text-xs text-muted-foreground">
          <span className="font-medium tracking-tight">RMIT University</span>
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-foreground">
            Staging Environment
          </span>
        </header>

        <main className="flex flex-1 items-center justify-center py-6">
          <Card className="w-full max-w-md rounded-xl border border-border/80 bg-card shadow-sm">
            <div className="p-6 sm:p-8">
              <div className="mb-6 flex items-center gap-3">
                <AppMark size="md" />
                <div className="text-left">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    School of Computing Technologies
                  </p>
                  <p className="text-xs font-medium text-primary">Admin &amp; Editorial Operations</p>
                </div>
              </div>

              <div className="mb-6 space-y-2 text-left">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
                <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
              </div>

              {children}

              {footer ? (
                <div className="mt-6 border-t border-border/60 pt-4 text-center text-xs leading-relaxed text-muted-foreground">
                  {footer}
                </div>
              ) : null}
            </div>
          </Card>
        </main>

        <footer className="border-t border-border/40 pt-4 text-center text-xs text-muted-foreground">
          Capstone Impact Platform &copy; 2026 RMIT University. All rights reserved.
        </footer>
      </div>
    </div>
  );
}
