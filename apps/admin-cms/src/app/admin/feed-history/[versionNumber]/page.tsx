import Link from 'next/link';

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileCheck2,
  GitCompareArrows,
  ShieldCheck,
} from 'lucide-react';

import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';

import { SupabaseFeedHistoryRepository } from '../../../../repositories/SupabaseFeedHistoryRepository';

import {
  prepareFeedRollback,
} from '../../../../feed/feedRollbackPreparation';

import {
  downloadCanonicalPublicFeed,
} from '../../../../storage/publicFeedStorage';

import {
  FeedRollbackExecutionPanel,
} from '../../../../components/admin/FeedRollbackExecutionPanel';

import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '../../../../components/ui/card';

import { ErrorState } from '../../../../components/ui/error-state';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{
    versionNumber: string;
  }>;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Not recorded';
  }

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function operationLabel(
  value: 'publication' | 'removal' | 'rollback',
): string {
  switch (value) {
    case 'publication':
      return 'Publication';

    case 'removal':
      return 'Public removal';

    case 'rollback':
      return 'Rollback';
  }
}

function operationBadgeVariant(
  value: 'publication' | 'removal' | 'rollback',
): 'success' | 'warning' | 'information' {
  switch (value) {
    case 'publication':
      return 'success';

    case 'removal':
      return 'warning';

    case 'rollback':
      return 'information';
  }
}

export default async function FeedVersionPage({
  params,
}: PageProps) {
  const resolvedParams = await params;

  const versionNumber =
    Number(resolvedParams.versionNumber);

  if (
    !Number.isSafeInteger(versionNumber) ||
    versionNumber <= 0
  ) {
    return (
      <ErrorState
        headingLevel="h2"
        title="Historical version not found"
        description="The requested feed version is not valid."
      />
    );
  }

  try {
    const adminContext = await requireAdmin();

    if (
      !hasPermission(
        adminContext.permissions,
        'projects.read',
      )
    ) {
      return (
        <ErrorState
          headingLevel="h2"
          title="Historical version unavailable"
          description="You do not have permission to inspect public-feed history."
        />
      );
    }

    const repository =
      new SupabaseFeedHistoryRepository();

    const version =
      await repository.getVersionByNumber(
        versionNumber,
      );

    if (!version) {
      return (
        <div className="mx-auto max-w-xl py-12">
          <ErrorState
            headingLevel="h2"
            title="Historical version not found"
            description="No immutable public-feed version exists with that version number."
            action={
              <Button
                asChild
                variant="outline"
              >
                <Link href="/admin/feed-history">
                  Return to feed history
                </Link>
              </Button>
            }
          />
        </div>
      );
    }

    const preparation =
      version.isCurrent
        ? null
        : await prepareFeedRollback({
            targetVersionId: version.id,

            dependencies: {
              getVersion:
                repository.getVersion.bind(
                  repository,
                ),

              downloadCanonicalFeed:
                downloadCanonicalPublicFeed,
            },
          });

    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-12">
        <div>
          <Link
            href="/admin/feed-history"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
          >
            <ArrowLeft
              className="h-3.5 w-3.5"
              aria-hidden="true"
            />

            Feed history
          </Link>
        </div>

        <div className="rounded-lg border border-border bg-card p-5 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-foreground sm:text-2xl">
                  Feed Version V
                  {version.versionNumber}
                </h1>

                {version.isCurrent && (
                  <Badge variant="primary">
                    Current
                  </Badge>
                )}

                <Badge
                  variant={operationBadgeVariant(
                    version.operationType,
                  )}
                >
                  {operationLabel(
                    version.operationType,
                  )}
                </Badge>
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                Created{' '}
                {formatTimestamp(
                  version.createdAt,
                )}
              </p>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileCheck2
                className="h-4 w-4 text-primary"
                aria-hidden="true"
              />

              <h2 className="text-base font-bold text-foreground">
                Historical evidence
              </h2>
            </div>

            <CardDescription>
              Immutable public-feed evidence captured
              when this version was created.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <dl className="grid grid-cols-1 gap-4 text-xs sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-muted-foreground">
                  Operation
                </dt>

                <dd className="mt-1 text-foreground">
                  {operationLabel(
                    version.operationType,
                  )}
                </dd>
              </div>

              <div>
                <dt className="font-semibold text-muted-foreground">
                  Record count
                </dt>

                <dd className="mt-1 text-foreground">
                  {version.recordCount}
                </dd>
              </div>

              <div>
                <dt className="font-semibold text-muted-foreground">
                  Actor
                </dt>

                <dd className="mt-1 text-foreground">
                  {version.actorName ||
                    'Authorized staff'}

                  {version.actorEmail && (
                    <span className="block text-muted-foreground">
                      {version.actorEmail}
                    </span>
                  )}
                </dd>
              </div>

              <div>
                <dt className="font-semibold text-muted-foreground">
                  Affected project
                </dt>

                <dd className="mt-1 text-foreground">
                  {version.affectedProjectTitle ||
                    'Feed-level action'}

                  {version.affectedPublicId && (
                    <span className="block text-muted-foreground">
                      {version.affectedPublicId}
                    </span>
                  )}
                </dd>
              </div>

              <div className="sm:col-span-2">
                <dt className="font-semibold text-muted-foreground">
                  SHA-256 checksum
                </dt>

                <dd className="mt-1 break-all rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
                  {version.feedHash}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {version.isCurrent ? (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
            <div className="flex items-start gap-2.5">
              <ShieldCheck
                className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                aria-hidden="true"
              />

              <div>
                <p className="text-sm font-semibold text-foreground">
                  This is the current feed version
                </p>

                <p className="mt-1 text-xs text-muted-foreground">
                  Rollback preparation is unnecessary
                  because the canonical feed already
                  points to this history version.
                </p>
              </div>
            </div>
          </div>
        ) : preparation?.resultCode ===
          'READY' ? (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <GitCompareArrows
                  className="h-4 w-4 text-primary"
                  aria-hidden="true"
                />

                <h2 className="text-base font-bold text-foreground">
                  Rollback preparation
                </h2>
              </div>

              <CardDescription>
                Read-only restoration plan. Nothing has
                been written or reserved.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="flex items-start gap-2.5 rounded-lg border border-success/30 bg-success/5 p-3.5">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-success"
                  aria-hidden="true"
                />

                <div className="text-xs">
                  <p className="font-semibold text-foreground">
                    Historical artifact verified
                  </p>

                  <p className="mt-1 text-muted-foreground">
                    SHA-256, record count, canonical
                    serialization and public-feed
                    validation all passed.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-4">
                  <p className="text-xs font-semibold text-muted-foreground">
                    Current canonical feed
                  </p>

                  <p className="mt-2 text-xl font-bold text-foreground">
                    {
                      preparation.preparation
                        .currentRecordCount
                    }{' '}
                    records
                  </p>

                  <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                    {
                      preparation.preparation
                        .currentFeedHash
                    }
                  </p>
                </div>

                <div className="rounded-lg border border-border p-4">
                  <p className="text-xs font-semibold text-muted-foreground">
                    Restore target
                  </p>

                  <p className="mt-2 text-xl font-bold text-foreground">
                    {
                      preparation.preparation
                        .targetRecordCount
                    }{' '}
                    records
                  </p>

                  <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                    {
                      preparation.preparation
                        .targetFeedHash
                    }
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-bold text-foreground">
                  Exact restoration plan
                </h3>

                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground">
                      Added to feed
                    </p>

                    <p className="mt-1 text-lg font-bold text-foreground">
                      {
                        preparation.preparation
                          .addedPublicIds.length
                      }
                    </p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-muted-foreground">
                      Removed from feed
                    </p>

                    <p className="mt-1 text-lg font-bold text-foreground">
                      {
                        preparation.preparation
                          .removedPublicIds.length
                      }
                    </p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-muted-foreground">
                      Retained
                    </p>

                    <p className="mt-1 text-lg font-bold text-foreground">
                      {
                        preparation.preparation
                          .retainedPublicIds.length
                      }
                    </p>
                  </div>
                </div>
              </div>

              {preparation.preparation
                .wouldChangeFeed ? (
                <FeedRollbackExecutionPanel
                  versionNumber={
                    version.versionNumber
                  }
                  targetVersionId={
                    version.id
                  }
                  preparedBaselineFeedHash={
                    preparation.preparation
                      .currentFeedHash
                  }
                  currentRecordCount={
                    preparation.preparation
                      .currentRecordCount
                  }
                  targetRecordCount={
                    preparation.preparation
                      .targetRecordCount
                  }
                />
              ) : (
                <div className="rounded-lg border border-border bg-muted/30 p-3.5 text-xs text-muted-foreground">
                  The current canonical feed already
                  contains the same verified artifact.
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                aria-hidden="true"
              />

              <div>
                <p className="text-sm font-semibold text-foreground">
                  Rollback preparation rejected
                </p>

                <p className="mt-1 text-xs text-muted-foreground">
                  Result:{' '}
                  <code className="font-mono">
                    {preparation?.resultCode ||
                      'PREPARATION_UNAVAILABLE'}
                  </code>
                </p>

                {preparation &&
                  'failureCode' in preparation &&
                  preparation.failureCode && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Evidence code:{' '}
                      <code className="font-mono">
                        {
                          preparation.failureCode
                        }
                      </code>
                    </p>
                  )}
              </div>
            </div>
          </div>
        )}

        <div>
          <Button
            asChild
            variant="outline"
          >
            <Link href="/admin/feed-history">
              <ArrowLeft
                className="mr-2 h-4 w-4"
                aria-hidden="true"
              />

              Back to Feed History
            </Link>
          </Button>
        </div>
      </div>
    );
  } catch (error: unknown) {
    console.error(
      '[Feed version inspection failure]',
      error instanceof Error
        ? error.name
        : 'UNKNOWN_FAILURE',
    );

    return (
      <ErrorState
        headingLevel="h2"
        title="Historical version unavailable"
        description="The historical feed version could not be inspected safely."
        action={
          <Button
            asChild
            variant="outline"
          >
            <Link href="/admin/feed-history">
              Return to feed history
            </Link>
          </Button>
        }
      />
    );
  }
}