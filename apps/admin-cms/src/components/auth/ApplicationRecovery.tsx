'use client';

import { Button } from '../ui/button';
import { INSTITUTION_NAME, SCHOOL_NAME } from '../../domain/institution';

export function ApplicationRecovery({ retry, notFound = false }: { retry?: () => void; notFound?: boolean }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-5 p-6 text-foreground">
      <p className="text-sm text-muted-foreground">{INSTITUTION_NAME} · {SCHOOL_NAME}</p>
      <h1 className="text-2xl font-bold">{notFound ? 'Page not found' : 'This page is temporarily unavailable'}</h1>
      <p>{notFound ? 'The requested address does not match an available application page.' : 'The page could not finish loading. Retry loading it, or return to Projects.'}</p>
      {!notFound && <p className="text-sm text-muted-foreground">A page error does not confirm whether a previous action succeeded. Check the project or activity history before repeating an import, publication or other change.</p>}
      <div className="flex flex-wrap gap-3">
        {retry && <Button type="button" onClick={retry}>Retry loading page</Button>}
        <Button asChild variant="outline"><a href="/admin">Return to Projects</a></Button>
        <Button asChild variant="outline"><a href="/login">Staff sign-in</a></Button>
      </div>
    </main>
  );
}
