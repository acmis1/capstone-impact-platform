import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import { AdminAuthError, AuthenticatedAdminContext } from '../../../../auth/authTypes';
import BrowserImportPreviewClient from '../../../../components/imports/BrowserImportPreviewClient';
import { Button } from '../../../../components/ui/button';
import { ErrorState } from '../../../../components/ui/error-state';

export const dynamic = 'force-dynamic';

export default async function NewImportPreviewPage() {
  let authContext: AuthenticatedAdminContext;
  try {
    authContext = await requireAdmin();
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) {
      if (err.type === 'UNAUTHENTICATED') {
        redirect('/login');
      }
      if (err.type === 'CONFIGURATION_FAILURE') {
        return (
          <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full py-12">
            <ErrorState
              title="Import service unavailable"
              description="Authentication service is temporarily unavailable. Please try again."
              action={
                <Button asChild variant="outline">
                  <Link href="/admin/imports">Return to Imports</Link>
                </Button>
              }
            />
          </div>
        );
      }
      return (
        <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full py-12">
          <ErrorState
            title="Import access required"
            description="Your account does not have permission to import projects."
            action={
              <Button asChild variant="outline">
                <Link href="/admin/imports">Return to Imports</Link>
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full py-12">
        <ErrorState
          title="Import unavailable"
          description="An unexpected error occurred while verifying credentials. Please try again."
          action={
            <Button asChild variant="outline">
              <Link href="/admin/imports">Return to Imports</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const canEdit = hasPermission(authContext.permissions, 'projects.edit');

  if (!canEdit) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full py-12">
        <ErrorState
          title="Import access required"
          description="Your account does not have permission to import projects."
          action={
            <Button asChild variant="outline">
              <Link href="/admin/imports">Return to Imports</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            Import projects
          </h2>
          <p className="text-sm text-muted-foreground">
            Check project files and import them into the test environment.
          </p>
        </div>

        <div className="shrink-0">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/imports">
              All imports
            </Link>
          </Button>
        </div>
      </div>

      {/* Main Guided Import Client Workflow */}
      <BrowserImportPreviewClient />
    </div>
  );
}
