import * as React from 'react';
import { Skeleton } from '../../../../components/ui/skeleton';

/**
 * Route-level loading state for the project detail workspace.
 *
 * Without it this route falls back to the `/admin` boundary, which renders the projects-index
 * skeleton — a metrics strip, filter panel, and results table that never appear here. The
 * skeleton below mirrors the real workspace instead (header, decision area, two-column
 * workspace, history), so space is reserved and no layout shift occurs.
 *
 * No placeholder status, workflow stage, or record value is rendered: an unknown project must
 * never appear to have a state. Skeleton animation is suppressed by the global reduced-motion
 * rule in `globals.css`.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 pb-16 xl:gap-8"
    >
      <span className="sr-only">Loading project details.</span>

      {/* Orientation header */}
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-36" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-80 max-w-full" />
            <Skeleton className="h-5 w-96 max-w-full" />
          </div>
          <Skeleton className="h-6 w-24" />
        </div>
      </div>

      {/* Review status and actions */}
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-64 max-w-full" />
          <Skeleton className="h-5 w-full max-w-2xl" />
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] lg:gap-8">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>

      {/* Workspace: review content plus contextual rail */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-8">
        <div className="flex min-w-0 flex-col gap-6">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-xl border bg-card p-4 sm:p-6">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-6 w-56 max-w-full" />
                <Skeleton className="h-4 w-full max-w-xl" />
              </div>
              <div className="mt-5 flex flex-col gap-2.5">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-xl border bg-card p-4 sm:p-5">
            <Skeleton className="h-6 w-36" />
            <div className="mt-4 flex flex-col gap-3.5">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-4 w-40 max-w-full" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4 sm:p-5">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-3 h-9 w-full" />
          </div>
        </div>
      </div>

      {/* Technical details and change history */}
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <Skeleton className="h-6 w-72 max-w-full" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-44" />
        <div className="rounded-xl border bg-card">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="border-b p-4 last:border-b-0 sm:px-6">
              <Skeleton className="h-5 w-64 max-w-full" />
              <Skeleton className="mt-2 h-4 w-40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
