'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
} from 'lucide-react';
import { AllowedSortField, ProjectListQuery } from '../../domain/projectQuery';
import { ProjectStatusBadge } from '../admin/ProjectStatusBadge';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  getProjectDetailHref,
  getProjectColumnSortField,
  ProjectIndexRow,
  ProjectIndexResult,
} from './projectDashboardHelpers';
import { useDashboardPreferences } from './useDashboardPreferences';
import {
  DASHBOARD_CONFIGURABLE_COLUMN_IDS,
  type DashboardColumnId,
} from './dashboardPreferences';

export interface ProjectTableContainerProps {
  query: ProjectListQuery;
  result: ProjectIndexResult;
}

const columnHelper = createColumnHelper<ProjectIndexRow>();

const COLUMN_LABELS: Record<DashboardColumnId, string> = {
  title: 'Project',
  status: 'Status',
  program: 'Program & discipline',
  year: 'Year',
  validation: 'Validation',
  updatedAt: 'Updated',
  actions: 'Actions',
};

/**
 * Proportional column widths. Without them the automatic table layout hands almost all
 * spare width to the long project titles, which squeezes program, discipline and the
 * status/validation labels into unreadable stacks. Percentages simply re-weight the
 * remaining columns when some are hidden.
 */
const COLUMN_WIDTH_CLASSES: Record<DashboardColumnId, string> = {
  title: 'w-[28%]',
  status: 'w-[12%]',
  program: 'w-[19%]',
  year: 'w-[7%]',
  validation: 'w-[12%]',
  updatedAt: 'w-[12%]',
  actions: 'w-[10%]',
};

function formatDate(dateStr?: string) {
  if (!dateStr) return 'Not recorded';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Not recorded';
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Not recorded';
  }
}

/** Secondary identifying context for a project, kept as one wrapping line. */
function supportingContext(row: ProjectIndexRow): string | null {
  const parts: string[] = [];
  if (row.groupName) parts.push(`Group: ${row.groupName}`);
  if (row.industryPartner) parts.push(`Partner: ${row.industryPartner}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function ProjectTableContainer({ query, result }: ProjectTableContainerProps) {
  // Opt out of React Compiler memoization because useReactTable is an incompatible library boundary
  "use no memo";

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { preferences, updatePreferences } = useDashboardPreferences();

  const handleSort = React.useCallback(
    (field: string) => {
      // Validate sort field before updating the URL
      const sortableFields = [
        'created_at',
        'updated_at',
        'title',
        'year',
        'status',
      ] as const;

      if (!sortableFields.includes(field as typeof sortableFields[number])) {
        return;
      }
      const currentSort = query.sort || 'created_at';
      const currentDirection = query.direction || 'desc';

      let nextDirection: 'asc' | 'desc' = 'asc';
      if (currentSort === field) {
        nextDirection = currentDirection === 'asc' ? 'desc' : 'asc';
      }
      updatePreferences({ sort: field as AllowedSortField, direction: nextDirection });

      const params = new URLSearchParams(searchParams?.toString() || '');
      params.set('sort', field);
      params.set('direction', nextDirection);
      params.delete('page'); // Reset to page 1

      router.push(`${pathname}?${params.toString()}`);
    },
    [query.sort, query.direction, searchParams, pathname, router, updatePreferences]
  );

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams?.toString() || '');
    params.set('page', newPage.toString());
    router.push(`${pathname}?${params.toString()}`);
  };

  const renderSortHeader = React.useCallback(
    (label: string, field: string) => {
      const isSorted = query.sort === field;
      const isAsc = query.direction === 'asc';

      return (
        <button
          type="button"
          onClick={() => handleSort(field)}
          aria-label={`Sort by ${label} ${isSorted && isAsc ? 'descending' : 'ascending'}`}
          className="inline-flex items-center gap-1.5 rounded-sm text-sm font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span>{label}</span>
          {isSorted ? (
            isAsc ? (
              <ArrowUp className="size-4 text-foreground" aria-hidden="true" />
            ) : (
              <ArrowDown className="size-4 text-foreground" aria-hidden="true" />
            )
          ) : (
            <ArrowUpDown className="size-4 text-muted-foreground/60" aria-hidden="true" />
          )}
        </button>
      );
    },
    [query.sort, query.direction, handleSort]
  );

  const staticHeader = React.useCallback(
    (label: string) => (
      <span className="text-sm font-semibold text-muted-foreground">{label}</span>
    ),
    []
  );

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('title', {
        header: () => renderSortHeader(COLUMN_LABELS.title, 'title'),
        cell: (info) => {
          const row = info.row.original;
          const secondary = supportingContext(row);
          return (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold leading-snug text-foreground">
                {row.title}
              </span>
              <span className="font-mono text-xs leading-normal break-words text-foreground-subtle">
                {row.publicId || `ID-${row.id}`}
              </span>
              {secondary && (
                <span className="text-xs leading-normal text-muted-foreground">{secondary}</span>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('status', {
        header: () => renderSortHeader(COLUMN_LABELS.status, 'status'),
        // Labels stay on one line: a pill with wrapped text reads as a layout fault.
        cell: (info) => <ProjectStatusBadge status={info.getValue()} className="whitespace-nowrap" />,
      }),
      columnHelper.accessor('program', {
        header: () => staticHeader(COLUMN_LABELS.program),
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm leading-snug text-foreground">
                {row.program || 'Not specified'}
              </span>
              <span className="text-xs leading-normal text-muted-foreground">
                {row.discipline || 'General'}
              </span>
            </div>
          );
        },
      }),
      columnHelper.accessor('year', {
        header: () => renderSortHeader(COLUMN_LABELS.year, 'year'),
        cell: (info) => (
          <span className="text-sm tabular-nums text-foreground">{info.getValue()}</span>
        ),
      }),
      columnHelper.display({
        id: 'validation',
        header: () => staticHeader(COLUMN_LABELS.validation),
        cell: (info) => {
          const row = info.row.original;
          return (
            <Badge variant={row.validationVariant} className="whitespace-nowrap">
              {row.validationLabel}
            </Badge>
          );
        },
      }),
      columnHelper.accessor('updatedAt', {
        header: () => renderSortHeader(COLUMN_LABELS.updatedAt, 'updated_at'),
        cell: (info) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(info.getValue() || info.row.original.createdAt)}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => <span className="sr-only">{COLUMN_LABELS.actions}</span>,
        cell: (info) => {
          const href = getProjectDetailHref(info.row.original.publicId);
          if (!href) {
            return <span className="text-sm italic text-muted-foreground">Unavailable</span>;
          }
          return (
            <Link
              href={href}
              className="inline-flex min-h-[40px] items-center justify-center whitespace-nowrap rounded-md border border-input bg-background px-3 text-sm font-semibold text-foreground shadow-2xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              View project
            </Link>
          );
        },
      }),
    ],
    [renderSortHeader, staticHeader]
  );

  // TanStack Table's useReactTable returns an API that React Compiler cannot safely memoize;
  // this component is explicitly opted out with "use no memo".
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: result.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: result.pageCount,
    state: {
      columnVisibility: Object.fromEntries(
        DASHBOARD_CONFIGURABLE_COLUMN_IDS.map((column) => [
          column,
          preferences.visibleColumns.includes(column),
        ]),
      ),
    },
  });

  const { page, pageCount, total, pageSize } = result;
  const fromRecord = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const toRecord = Math.min(page * pageSize, total);
  const totalPages = Math.max(pageCount, 1);
  const visibleConfigurableCount = DASHBOARD_CONFIGURABLE_COLUMN_IDS.filter((column) =>
    preferences.visibleColumns.includes(column),
  ).length;

  const toggleColumn = (column: DashboardColumnId) => {
    const visibleColumns: DashboardColumnId[] = preferences.visibleColumns.includes(column)
      ? preferences.visibleColumns.filter((value) => value !== column)
      : [...preferences.visibleColumns, column];
    updatePreferences({ visibleColumns });
  };

  return (
    <section aria-labelledby="project-results-heading" className="flex flex-col gap-3">
      <h3 id="project-results-heading" className="sr-only">
        Project results
      </h3>

      {/* Result range and secondary view settings */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Showing{' '}
          <span className="font-semibold tabular-nums text-foreground">
            {fromRecord}&ndash;{toRecord}
          </span>{' '}
          of <span className="font-semibold tabular-nums text-foreground">{total}</span>{' '}
          {total === 1 ? 'project' : 'projects'}
        </p>

        {/* Non-modal: the column menu is a secondary setting and must never hide the
            table from assistive technology or block interaction with the page behind it. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="hidden min-h-[40px] md:inline-flex">
              <Columns3 aria-hidden="true" />
              <span>Columns</span>
              <span className="font-normal text-muted-foreground">
                {visibleConfigurableCount} of {DASHBOARD_CONFIGURABLE_COLUMN_IDS.length}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[16rem]">
            <DropdownMenuLabel>Desktop table columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {DASHBOARD_CONFIGURABLE_COLUMN_IDS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column}
                checked={preferences.visibleColumns.includes(column)}
                onCheckedChange={() => toggleColumn(column)}
                onSelect={(event) => event.preventDefault()}
              >
                {COLUMN_LABELS[column]}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              Project and Actions always stay visible. Mobile project cards are not affected.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Desktop/Tablet Table View */}
      <div className="hidden overflow-hidden rounded-lg border bg-card shadow-xs md:block">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              Capstone project records, showing {fromRecord} to {toRecord} of {total}.
            </caption>
            <thead className="border-b bg-muted/40">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const sortField = getProjectColumnSortField(header.column.id);
                    const isSorted = sortField !== null && query.sort === sortField;
                    const isAsc = query.direction === 'asc';
                    const ariaSort = isSorted
                      ? (isAsc ? 'ascending' : 'descending')
                      : (sortField !== null ? 'none' : undefined);

                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={ariaSort}
                        className={cn(
                          'px-4 py-3 align-bottom font-semibold',
                          COLUMN_WIDTH_CLASSES[header.column.id as DashboardColumnId],
                        )}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y">
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="transition-colors hover:bg-muted/30">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 align-top font-normal">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card List Fallback */}
      <ul className="flex list-none flex-col gap-3 md:hidden">
        {result.rows.map((row) => {
          const href = getProjectDetailHref(row.publicId);
          const secondary = supportingContext(row);

          return (
            <li key={row.id} className="rounded-lg border bg-card p-4 shadow-xs">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <h4 className="text-sm font-semibold leading-snug text-foreground">
                    {row.title}
                  </h4>
                  <span className="font-mono text-xs leading-normal break-words text-foreground-subtle">
                    {row.publicId || `ID-${row.id}`}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <ProjectStatusBadge status={row.status} />
                  <Badge variant={row.validationVariant}>{row.validationLabel}</Badge>
                </div>

                <dl className="flex flex-col gap-1.5 text-sm">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Program</dt>
                    <dd className="min-w-0 text-foreground">{row.program || 'Not specified'}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Discipline</dt>
                    <dd className="min-w-0 text-foreground">{row.discipline || 'General'}</dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Year</dt>
                    <dd className="min-w-0 tabular-nums text-foreground">{row.year}</dd>
                  </div>
                  {secondary && (
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="sr-only">Context</dt>
                      <dd className="min-w-0 text-muted-foreground">{secondary}</dd>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd className="min-w-0 text-foreground">
                      {formatDate(row.updatedAt || row.createdAt)}
                    </dd>
                  </div>
                </dl>

                {href ? (
                  <Link
                    href={href}
                    className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-semibold text-foreground shadow-2xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    View project
                  </Link>
                ) : (
                  <span className="text-sm italic text-muted-foreground">Unavailable</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Pagination Bar */}
      <nav
        aria-label="Project results pages"
        className="flex flex-col items-start gap-3 rounded-lg border bg-card px-4 py-3 shadow-xs sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="text-sm text-muted-foreground">
          Page <span className="font-semibold tabular-nums text-foreground">{page}</span> of{' '}
          <span className="font-semibold tabular-nums text-foreground">{totalPages}</span>
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => handlePageChange(page - 1)}
            aria-label="Go to previous page"
            className="min-h-[40px] gap-1"
          >
            <ChevronLeft aria-hidden="true" />
            <span>Previous</span>
          </Button>
          <Button
            variant="outline"
            disabled={page >= pageCount || pageCount === 0}
            onClick={() => handlePageChange(page + 1)}
            aria-label="Go to next page"
            className="min-h-[40px] gap-1"
          >
            <span>Next</span>
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </nav>
    </section>
  );
}
