import * as React from 'react';
import { Skeleton } from '../../components/ui/skeleton';

/**
 * Route-level loading state for the Projects index. The skeleton mirrors the real page
 * structure (header, metrics strip, discovery panel, table, pagination) so space is reserved
 * and no layout shift occurs when the server data arrives. No placeholder metric values are
 * rendered. Skeleton animation is suppressed by the global reduced-motion rule.
 */
export function DashboardSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex w-full flex-col gap-6">
      <span className="sr-only">Loading project records.</span>

      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>

      {/* Metrics summary strip */}
      <div className="rounded-lg border bg-card">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2 p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-3 w-36" />
            </div>
          ))}
        </div>
        <div className="border-t px-4 py-2">
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
      </div>

      {/* Search and filter panel */}
      <div className="rounded-lg border bg-card">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Skeleton className="h-11 flex-1" />
              <Skeleton className="h-11 sm:w-32" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-11 w-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="border-t px-4 py-3">
          <Skeleton className="h-10 w-48" />
        </div>
      </div>

      {/* Result range and column settings */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-5 w-52" />
        <Skeleton className="h-10 w-36" />
      </div>

      {/* Project table */}
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-5 w-full" />
        </div>
        <div className="flex flex-col">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="border-b px-4 py-4 last:border-b-0">
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>

      {/* Pagination */}
      <div className="flex flex-col items-start gap-3 rounded-lg border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-5 w-28" />
        <div className="flex gap-2">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-24" />
        </div>
      </div>
    </div>
  );
}

export default function Loading() {
  return <DashboardSkeleton />;
}
