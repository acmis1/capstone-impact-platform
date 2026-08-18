import { cn } from '../../lib/utils';
import type { ImportBatchRow } from '../../repositories/ImportBatchRepositoryCore';
import { OPERATIONAL_SURFACE_CLASS_NAME } from '../ui/card';

export interface ImportSummaryMetrics {
  recentImports: number;
  completed: number;
  failed: number;
  totalWarnings: number;
  totalErrors: number;
}

type ImportSummaryMetricKey = keyof ImportSummaryMetrics;

export const IMPORT_SUMMARY_VALUE_CLASS_NAMES = {
  recentImports: 'text-foreground',
  completed: 'text-success',
  failed: 'text-destructive',
  totalWarnings: 'text-warning-strong',
  totalErrors: 'text-destructive',
} as const;

const SEPARATOR_CLASSES = [
  '',
  'border-l',
  'border-t sm:border-t-0 sm:border-l',
  'border-t border-l sm:border-l-0 lg:border-l lg:border-t-0',
  'col-span-2 border-t sm:col-span-1 sm:border-l lg:border-t-0',
];

/** Keeps the Imports summary calculations distinct from the batch-table query contract. */
export function getImportSummaryMetrics(batches: ImportBatchRow[]): ImportSummaryMetrics {
  return {
    recentImports: batches.length,
    completed: batches.filter((batch) => batch.status === 'completed').length,
    failed: batches.filter((batch) => batch.status === 'failed').length,
    totalWarnings: batches.reduce((total, batch) => total + (batch.warning_count || 0), 0),
    totalErrors: batches.reduce((total, batch) => total + (batch.error_count || 0), 0),
  };
}

export function getImportSummaryValueClass(
  metric: ImportSummaryMetricKey,
  value: number,
): string {
  if (metric === 'recentImports' || value === 0) {
    return IMPORT_SUMMARY_VALUE_CLASS_NAMES.recentImports;
  }

  return IMPORT_SUMMARY_VALUE_CLASS_NAMES[metric];
}

export function ImportMetricsSummary({ metrics }: { metrics: ImportSummaryMetrics }) {
  const items: Array<{ key: ImportSummaryMetricKey; label: string; value: number }> = [
    { key: 'recentImports', label: 'Recent imports', value: metrics.recentImports },
    { key: 'completed', label: 'Completed', value: metrics.completed },
    { key: 'failed', label: 'Failed', value: metrics.failed },
    { key: 'totalWarnings', label: 'Total warnings', value: metrics.totalWarnings },
    { key: 'totalErrors', label: 'Total errors', value: metrics.totalErrors },
  ];

  return (
    <section aria-labelledby="import-metrics-heading" className={OPERATIONAL_SURFACE_CLASS_NAME}>
      <h2 id="import-metrics-heading" className="sr-only">
        Import batch summary
      </h2>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item, index) => (
          <div key={item.key} className={cn('min-w-0 border-border p-4', SEPARATOR_CLASSES[index])}>
            <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{item.label}</dt>
            <dd
              className={cn(
                'mt-1 text-2xl font-bold tabular-nums',
                getImportSummaryValueClass(item.key, item.value),
              )}
            >
              {item.value.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
