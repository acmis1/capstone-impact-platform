import Link from 'next/link';
import { AppMark } from '../components/ui/app-mark';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { ArrowRight, ShieldAlert } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4 sm:p-6">
      <main className="w-full max-w-lg flex flex-col items-center text-center">
        {/* Brand Identity */}
        <div className="mb-6 flex flex-col items-center">
          <AppMark size="lg" className="mb-3" />
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
            Capstone Impact Platform
          </h1>
          <p className="text-sm font-medium text-muted-foreground mt-1">
            Admin System
          </p>
        </div>

        {/* Purpose Description */}
        <p className="text-sm sm:text-base text-muted-foreground mb-6 leading-relaxed max-w-md">
          An administrative system for collecting, reviewing, and preparing capstone projects for publication.
        </p>

        {/* Primary Action */}
        <div className="mb-8 w-full max-w-xs">
          <Button asChild size="lg" className="w-full font-semibold">
            <Link href="/admin">
              Open Admin
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {/* Staging Environment Notice Card */}
        <Card className="w-full border-border bg-card text-left">
          <CardContent className="pt-6 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-warning shrink-0 mt-0.5" aria-hidden="true" />
            <div className="text-xs text-muted-foreground leading-relaxed">
              <p className="font-semibold text-foreground mb-0.5">Test Environment</p>
              Work here uses staging data and does not update the public showcase website.
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
