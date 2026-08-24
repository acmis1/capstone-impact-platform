import Link from 'next/link';

import {
  ArchiveRestore,
  Clock3,
  FileClock,
  ShieldCheck,
} from 'lucide-react';

import { requireAdmin } from '../../../auth/requireAdmin';
import { hasPermission } from '../../../auth/permissions';

import { SupabaseFeedHistoryRepository } from '../../../repositories/SupabaseFeedHistoryRepository';

import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '../../../components/ui/card';

import { ErrorState } from '../../../components/ui/error-state';

export const dynamic = 'force-dynamic';

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
  operation: 'publication' | 'removal' | 'rollback',
): string {
  switch (operation) {
    case 'publication':
      return 'Publication';

    case 'removal':
      return 'Public removal';

    case 'rollback':
      return 'Rollback';
  }
}

function shortChecksum(hash: string): string {
  if (hash.length <= 20) {
    return hash;
  }

  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

export default async function FeedHistoryPage() {
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
          title="Feed history unavailable"
          description="You do not have permission to inspect public-feed history."
        />
      );
    }

    const repository =
      new SupabaseFeedHistoryRepository();

    const versions =
      await repository.listVersions(100);

    const current =
      versions.find((version) => version.isCurrent);

    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-12">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2 text-primary">
              <FileClock
                className="h-4 w-4"
                aria-hidden="true"
              />

              <span className="text-xs font-bold uppercase tracking-wider">
                Public feed
              </span>
            </div>

            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Feed Version History
            </h1>

            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Immutable evidence captured after successful
              controlled publication, public removal, and
              rollback operations.
            </p>
          </div>

          <Button
            asChild
            variant="outline"
            size="sm"
          >
            <Link href="/admin">
              Back to projects
            </Link>
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 p-3.5 text-xs text-muted-foreground">
          <div className="flex items-start gap-2.5">
            <ShieldCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
              aria-hidden="true"
            />

            <p>
              Historical feed versions are read-only evidence.
              Existing versions cannot be edited or deleted through
              this interface. A rollback creates a new version rather
              than rewriting earlier history.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>
                Historical versions
              </CardDescription>
            </CardHeader>

            <CardContent>
              <p className="text-2xl font-bold text-foreground">
                {versions.length}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>
                Current version
              </CardDescription>
            </CardHeader>

            <CardContent>
              <p className="text-2xl font-bold text-foreground">
                {current
                  ? `V${current.versionNumber}`
                  : 'None'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>
                Current record count
              </CardDescription>
            </CardHeader>

            <CardContent>
              <p className="text-2xl font-bold text-foreground">
                {current?.recordCount ?? '—'}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <h2 className="text-base font-bold text-foreground">
              Version history
            </h2>

            <CardDescription>
              Newest feed versions are shown first.
            </CardDescription>
          </CardHeader>

          <CardContent className="p-0">
            {versions.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <ArchiveRestore
                  className="mx-auto mb-3 h-7 w-7 text-muted-foreground"
                  aria-hidden="true"
                />

                <p className="text-sm font-semibold text-foreground">
                  No feed history yet
                </p>

                <p className="mt-1 text-xs text-muted-foreground">
                  A successful controlled publication or public
                  removal will create the first immutable version.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-muted/30">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">
                        Version
                      </th>

                      <th className="px-4 py-3 font-semibold text-muted-foreground">
                        Timestamp
                      </th>

                      <th className="px-4 py-3 font-semibold text-muted-foreground">
                        Operation
                      </th>

                      <th className="px-4 py-3 font-semibold text-muted-foreground">
                        Project
                      </th>

                      <th className="px-4 py-3 font-semibold text-muted-foreground">
                        Records
                      </th>

                      <th className="px-4 py-3 font-semibold text-muted-foreground">
                        Checksum
                      </th>

                      <th className="px-4 py-3 font-semibold text-muted-foreground">
                        Actor
                      </th>

                      <th className="px-4 py-3">
                        <span className="sr-only">
                          Actions
                        </span>
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-border">
                    {versions.map((version) => (
                      <tr
                        key={version.id}
                        className="hover:bg-muted/20"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-foreground">
                              V{version.versionNumber}
                            </span>

                            {version.isCurrent && (
                              <Badge>
                                Current
                              </Badge>
                            )}
                          </div>
                        </td>

                        <td className="px-4 py-3 text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <Clock3
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />

                            {formatTimestamp(
                              version.createdAt,
                            )}
                          </span>
                        </td>

                        <td className="px-4 py-3">
                          <Badge variant="neutral">
                            {operationLabel(
                              version.operationType,
                            )}
                          </Badge>
                        </td>

                        <td className="px-4 py-3">
                          {version.affectedProjectTitle ? (
                            <div>
                              <p className="font-semibold text-foreground">
                                {
                                  version.affectedProjectTitle
                                }
                              </p>

                              {version.affectedPublicId && (
                                <p className="mt-0.5 text-muted-foreground">
                                  {
                                    version.affectedPublicId
                                  }
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">
                              Feed-level action
                            </span>
                          )}
                        </td>

                        <td className="px-4 py-3 font-semibold text-foreground">
                          {version.recordCount}
                        </td>

                        <td className="px-4 py-3">
                          <code
                            className="rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground"
                            title={version.feedHash}
                          >
                            {shortChecksum(
                              version.feedHash,
                            )}
                          </code>
                        </td>

                        <td className="px-4 py-3">
                          <div>
                            <p className="font-medium text-foreground">
                              {version.actorName ||
                                'Authorized staff'}
                            </p>

                            {version.actorEmail && (
                              <p className="text-muted-foreground">
                                {version.actorEmail}
                              </p>
                            )}
                          </div>
                        </td>

                        <td className="px-4 py-3 text-right">
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                          >
                            <Link
                              href={`/admin/feed-history/${version.versionNumber}`}
                            >
                              Inspect
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  } catch (error: unknown) {
    console.error(
      '[Feed history load failure]',
      error instanceof Error
        ? error.name
        : 'UNKNOWN_FAILURE',
    );

    return (
      <div className="mx-auto max-w-xl py-12">
        <ErrorState
          headingLevel="h2"
          title="Feed history unavailable"
          description="Historical public-feed evidence could not be loaded safely."
          action={
            <Button
              asChild
              variant="outline"
            >
              <Link href="/admin">
                Return to projects
              </Link>
            </Button>
          }
        />
      </div>
    );
  }
}