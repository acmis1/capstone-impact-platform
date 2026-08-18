import * as React from 'react';
import { FolderKanban, CheckCircle2, Clock, Archive } from 'lucide-react';
import { ProjectDashboardMetrics } from '../../domain/projectQuery';
import { cn } from '../../lib/utils';
import { OPERATIONAL_SURFACE_CLASS_NAME } from '../ui/card';

export interface DashboardMetricsSummaryProps {
  metrics: ProjectDashboardMetrics;
}

/**
 * Separator classes per grid position. The strip is one surface divided by hairlines
 * rather than four independent cards, so the metrics stay subordinate to the table.
 * 2 columns below `lg`, 4 columns at `lg`.
 */
const SEPARATOR_CLASSES = [
  '',
  'border-l',
  'border-t lg:border-t-0 lg:border-l',
  'border-t border-l lg:border-t-0',
];

export function DashboardMetricsSummary({ metrics }: DashboardMetricsSummaryProps) {
  // Metric definitions are fixed by the repository contract and must stay exact.
  const items = [
    {
      label: 'Total projects',
      value: metrics.totalProjects,
      description: 'All non-deleted project records',
      icon: FolderKanban,
    },
    {
      label: 'Public eligible',
      value: metrics.publicEligible,
      description: 'Approved or published projects',
      icon: CheckCircle2,
    },
    {
      label: 'In review',
      value: metrics.inReview,
      description: 'Projects with In review status',
      icon: Clock,
    },
    {
      label: 'Archived',
      value: metrics.archived,
      description: 'Projects with Archived status',
      icon: Archive,
    },
  ];

  return (
    <section
      aria-labelledby="project-metrics-heading"
      className={OPERATIONAL_SURFACE_CLASS_NAME}
    >
      <h3 id="project-metrics-heading" className="sr-only">
        Project record summary
      </h3>

      <dl className="grid grid-cols-2 lg:grid-cols-4">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={cn('flex items-start gap-3 border-border p-4', SEPARATOR_CLASSES[index])}
            >
              <Icon
                className="mt-1 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-sm font-medium text-muted-foreground">{item.label}</dt>
                <dd className="flex flex-col gap-0.5">
                  <span className="text-2xl font-semibold leading-tight tabular-nums text-foreground">
                    {item.value.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.description}</span>
                </dd>
              </div>
            </div>
          );
        })}
      </dl>

      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        Summary counts cover all non-deleted project records and do not change with search or filters.
      </p>
    </section>
  );
}
