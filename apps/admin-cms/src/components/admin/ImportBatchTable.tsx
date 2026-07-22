import React from 'react';
import Link from 'next/link';
import ImportBatchStatusBadge from './ImportBatchStatusBadge';

export interface ImportBatchRow {
  id: string;
  batch_name: string;
  source_folder: string;
  mode: string;
  status: string;
  total_projects: number;
  error_count?: number;
  warning_count?: number;
  created_at: string;
}

export default function ImportBatchTable({ batches }: { batches: Array<ImportBatchRow | Record<string, unknown>> }) {
  if (!batches || batches.length === 0) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#9CA3AF' }}>
        No batches found.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid rgba(255, 255, 255, 0.05)', color: '#9CA3AF' }}>
            <th style={{ padding: '1rem 0.5rem' }}>Batch ID</th>
            <th style={{ padding: '1rem 0.5rem' }}>Batch Name</th>
            <th style={{ padding: '1rem 0.5rem' }}>Source Folder</th>
            <th style={{ padding: '1rem 0.5rem' }}>Mode</th>
            <th style={{ padding: '1rem 0.5rem' }}>Status</th>
            <th style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>Projects</th>
            <th style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>Errors</th>
            <th style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>Warnings</th>
            <th style={{ padding: '1rem 0.5rem' }}>Created At</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const id = String(batch.id || '');
            const batchName = String(batch.batch_name || '');
            const sourceFolder = String(batch.source_folder || '');
            const mode = String(batch.mode || '');
            const status = String(batch.status || '');
            const totalProjects = Number(batch.total_projects) || 0;
            const errorCount = Number(batch.error_count) || 0;
            const warningCount = Number(batch.warning_count) || 0;
            const createdAt = batch.created_at ? new Date(String(batch.created_at)).toLocaleString() : 'N/A';

            return (
              <tr key={id} className="project-row" style={{
                borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                transition: 'background-color 0.2s',
              }}>
                <td style={{ padding: '1rem 0.5rem' }}>
                  <Link href={`/admin/imports/${id}`} style={{
                    color: '#3B82F6',
                    fontFamily: 'monospace',
                    textDecoration: 'none',
                    fontWeight: 600
                  }}>
                    {id.substring(0, 8)}...
                  </Link>
                </td>
                <td style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>{batchName}</td>
                <td style={{ padding: '1rem 0.5rem', color: '#D1D5DB' }}><code>{sourceFolder}</code></td>
                <td style={{ padding: '1rem 0.5rem', color: '#9CA3AF' }}>{mode}</td>
                <td style={{ padding: '1rem 0.5rem' }}>
                  <ImportBatchStatusBadge status={status} />
                </td>
                <td style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>{totalProjects}</td>
                <td style={{ padding: '1rem 0.5rem', textAlign: 'center', color: errorCount > 0 ? '#EF4444' : '#9CA3AF', fontWeight: errorCount > 0 ? 600 : 400 }}>
                  {errorCount}
                </td>
                <td style={{ padding: '1rem 0.5rem', textAlign: 'center', color: warningCount > 0 ? '#F59E0B' : '#9CA3AF', fontWeight: warningCount > 0 ? 600 : 400 }}>
                  {warningCount}
                </td>
                <td style={{ padding: '1rem 0.5rem', color: '#9CA3AF' }}>
                  {createdAt}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
