import React from 'react';
import Link from 'next/link';
import ImportBatchStatusBadge from './ImportBatchStatusBadge';
import { ImportBatchRow } from '../../repositories/ImportBatchRepositoryCore';

function formatBatchIssues(errorCount: number, warningCount: number) {
  if (errorCount === 0 && warningCount === 0) {
    return <span className="text-muted-foreground">None</span>;
  }

  const parts: React.ReactNode[] = [];
  if (errorCount > 0) {
    parts.push(
      <span key="err" className="text-destructive font-medium">
        {errorCount} {errorCount === 1 ? 'error' : 'errors'}
      </span>
    );
  }
  if (warningCount > 0) {
    if (parts.length > 0) parts.push(<span key="sep">, </span>);
    parts.push(
      <span key="warn" className="text-warning font-medium">
        {warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
      </span>
    );
  }

  return <>{parts}</>;
}

export default function ImportBatchTable({ batches }: { batches: ImportBatchRow[] }) {
  if (!batches || batches.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No import records found.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto w-full">
      <table className="w-full text-left text-sm border-collapse">
        <thead>
          <tr className="border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            <th className="py-3 px-4">Import</th>
            <th className="py-3 px-4">Source</th>
            <th className="py-3 px-4">Date</th>
            <th className="py-3 px-4">Status</th>
            <th className="py-3 px-4 text-center">Projects</th>
            <th className="py-3 px-4">Issues</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {batches.map((b) => (
            <tr
              key={b.id}
              className="hover:bg-muted/50 transition-colors"
            >
              <td className="py-3.5 px-4 font-semibold text-foreground">
                <Link
                  href={`/admin/imports/${b.id}`}
                  className="text-foreground hover:text-primary hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                >
                  {b.batch_name || 'Import batch'}
                </Link>
              </td>
              <td className="py-3.5 px-4 text-muted-foreground font-mono text-xs max-w-[200px] truncate">
                <span title={b.source_folder}>{b.source_folder}</span>
              </td>
              <td className="py-3.5 px-4 text-muted-foreground whitespace-nowrap text-xs">
                {new Date(b.created_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </td>
              <td className="py-3.5 px-4 whitespace-nowrap">
                <ImportBatchStatusBadge status={b.status} />
              </td>
              <td className="py-3.5 px-4 text-center font-medium text-foreground">
                {b.total_projects}
              </td>
              <td className="py-3.5 px-4 whitespace-nowrap text-xs">
                {formatBatchIssues(b.error_count || 0, b.warning_count || 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
