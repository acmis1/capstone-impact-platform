import * as React from 'react';
import { Card, CardHeader, CardContent, CardFooter } from '../ui/card';
import { Button } from '../ui/button';
import { ShieldAlert, AlertTriangle } from 'lucide-react';

export interface AuthErrorScreenProps {
  heading: string;
  message: string;
  logoutAction: () => Promise<void>;
  isConfigFailure?: boolean;
}

export function AuthErrorScreen({
  heading,
  message,
  logoutAction,
  isConfigFailure = false,
}: AuthErrorScreenProps) {
  const Icon = isConfigFailure ? AlertTriangle : ShieldAlert;

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-4 sm:p-6">
      <Card className="max-w-md w-full text-center shadow-md border-border/80 bg-card">
        <CardHeader className="flex flex-col items-center gap-3 pt-6 sm:pt-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive border border-destructive/20">
            <Icon className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            {heading}
          </h1>
        </CardHeader>
        <CardContent className="px-6 pb-2">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {message}
          </p>
        </CardContent>
        <CardFooter className="justify-center pb-6 sm:pb-8 pt-4">
          <form action={logoutAction}>
            <Button type="submit" variant="outline" size="default" className="min-w-[120px] font-semibold">
              Sign Out
            </Button>
          </form>
        </CardFooter>
      </Card>
    </main>
  );
}
