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
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <Card className="max-w-md w-full text-center shadow-lg border-border">
        <CardHeader className="flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Icon className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold text-destructive">
            {heading}
          </h1>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {message}
          </p>
        </CardContent>
        <CardFooter className="justify-center pt-2">
          <form action={logoutAction}>
            <Button type="submit" variant="outline">
              Sign Out
            </Button>
          </form>
        </CardFooter>
      </Card>
    </main>
  );
}
