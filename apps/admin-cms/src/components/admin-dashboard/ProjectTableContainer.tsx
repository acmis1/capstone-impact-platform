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
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Project } from '../../domain/project';
import { ProjectListQuery, ProjectListResult } from '../../domain/projectQuery';
import { ProjectStatusBadge } from '../admin/ProjectStatusBadge';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

export interface ProjectTableContainerProps {
  query: ProjectListQuery;
  result: ProjectListResult;
}

const columnHelper = createColumnHelper<Project>();

function getValidationBadge(project: Project) {
  const flags = project.validationFlags;
  const errorsCount = project.validationErrors?.length || 0;
  const warningsCount = project.validationWarnings?.length || 0;

  if (errorsCount > 0 || flags?.hasErrors) {
    return (
      <Badge variant="destructive" className="text-xs">
        {errorsCount > 0 ? `${errorsCount} Error${errorsCount > 1 ? 's' : ''}` : 'Needs attention'}
      </Badge>
    );
  }

  if (warningsCount > 0 || flags?.hasWarnings) {
    return (
      <Badge variant="warning" className="text-xs">
        {warningsCount > 0 ? `${warningsCount} Warning${warningsCount > 1 ? 's' : ''}` : 'Warnings'}
      </Badge>
    );
  }

  return (
    <Badge variant="success" className="text-xs">
      Ready
    </Badge>
  );
}

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

export function ProjectTableContainer({ query, result }: ProjectTableContainerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleSort = React.useCallback(
    (field: string) => {
      const currentSort = query.sort || 'created_at';
      const currentDirection = query.direction || 'desc';

      let nextDirection: 'asc' | 'desc' = 'asc';
      if (currentSort === field) {
        nextDirection = currentDirection === 'asc' ? 'desc' : 'asc';
      }

      const params = new URLSearchParams(searchParams?.toString() || '');
      params.set('sort', field);
      params.set('direction', nextDirection);
      params.delete('page'); // Reset to page 1

      router.push(`${pathname}?${params.toString()}`);
    },
    [query.sort, query.direction, searchParams, pathname, router]
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
          className="flex items-center gap-1 font-semibold text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-xs"
        >
          <span>{label}</span>
          {isSorted ? (
            isAsc ? (
              <ArrowUp className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            )
          ) : (
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />
          )}
        </button>
      );
    },
    [query.sort, query.direction, handleSort]
  );

  const columns = React.useMemo(
    () => [
      columnHelper.accessor('title', {
        header: () => renderSortHeader('Project', 'title'),
        cell: (info) => {
          const row = info.row.original;
          const secondary = row.groupName || row.industryPartner || row.summary;
          return (
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold text-foreground text-sm leading-snug">
                {row.title}
              </span>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono text-[11px] font-medium text-primary">
                  {row.publicId || `ID-${row.id}`}
                </span>
                {secondary && (
                  <>
                    <span>•</span>
                    <span className="truncate max-w-[200px]">{secondary}</span>
                  </>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('status', {
        header: () => renderSortHeader('Status', 'status'),
        cell: (info) => <ProjectStatusBadge status={info.getValue()} />,
      }),
      columnHelper.accessor('program', {
        header: () => <span className="font-semibold text-xs text-muted-foreground">Program & Discipline</span>,
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="flex flex-col gap-0.5 text-xs">
              <span className="font-medium text-foreground">{row.program || 'Not specified'}</span>
              <span className="text-muted-foreground">{row.discipline || 'General'}</span>
            </div>
          );
        },
      }),
      columnHelper.accessor('year', {
        header: () => renderSortHeader('Year', 'year'),
        cell: (info) => <span className="text-xs font-semibold text-foreground">{info.getValue()}</span>,
      }),
      columnHelper.display({
        id: 'validation',
        header: () => <span className="font-semibold text-xs text-muted-foreground">Validation</span>,
        cell: (info) => getValidationBadge(info.row.original),
      }),
      columnHelper.accessor('updated_at', {
        header: () => renderSortHeader('Updated', 'updated_at'),
        cell: (info) => (
          <span className="text-xs text-muted-foreground">
            {formatDate(info.getValue() || info.row.original.created_at)}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const publicId = info.row.original.publicId;
          const href = publicId ? `/admin/projects/${encodeURIComponent(publicId)}` : '/admin';
          return (
            <Link
              href={href}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-semibold text-foreground shadow-2xs hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[36px]"
            >
              View project
            </Link>
          );
        },
      }),
    ],
    [renderSortHeader]
  );

  const table = useReactTable({
    data: result.projects,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: result.pageCount,
  });

  const { page, pageCount, total, pageSize } = result;
  const fromRecord = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const toRecord = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col gap-4">
      {/* Desktop/Tablet Table View */}
      <div className="hidden md:block rounded-lg border bg-card shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead className="bg-muted/50 border-b">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id} className="p-3 font-semibold text-xs text-muted-foreground">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y border-b">
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                  {row.getVisibleCells().map((cell) => (
                    <th key={cell.id} className="p-3 align-middle font-normal">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card List Fallback */}
      <div className="flex flex-col gap-3 md:hidden">
        {result.projects.map((project) => {
          const publicId = project.publicId;
          const href = publicId ? `/admin/projects/${encodeURIComponent(publicId)}` : '/admin';

          return (
            <div key={project.id} className="flex flex-col gap-2 rounded-lg border bg-card p-4 shadow-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="font-semibold text-foreground text-sm leading-snug">
                    {project.title}
                  </span>
                  <span className="font-mono text-xs text-primary font-medium">
                    {project.publicId || `ID-${project.id}`}
                  </span>
                </div>
                <ProjectStatusBadge status={project.status} />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground pt-1 border-t">
                <span>{project.program || 'Program'}</span>
                <span>•</span>
                <span>{project.year}</span>
                <span>•</span>
                {getValidationBadge(project)}
              </div>

              <div className="flex items-center justify-between pt-2 border-t mt-1">
                <span className="text-xs text-muted-foreground">
                  Updated: {formatDate(project.updated_at || project.created_at)}
                </span>
                <Link
                  href={href}
                  className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold shadow-2xs hover:bg-primary/90 min-h-[44px]"
                >
                  View project
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 rounded-lg border bg-card p-3 text-xs text-muted-foreground shadow-xs">
        <div>
          Showing <span className="font-semibold text-foreground">{fromRecord}</span> to{' '}
          <span className="font-semibold text-foreground">{toRecord}</span> of{' '}
          <span className="font-semibold text-foreground">{total}</span> project records
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => handlePageChange(page - 1)}
            aria-label="Go to previous page"
            className="gap-1 min-h-[44px] sm:min-h-[36px]"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span>Previous</span>
          </Button>
          <span className="font-medium text-foreground px-2">
            Page {page} of {Math.max(pageCount, 1)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount || pageCount === 0}
            onClick={() => handlePageChange(page + 1)}
            aria-label="Go to next page"
            className="gap-1 min-h-[44px] sm:min-h-[36px]"
          >
            <span>Next</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
