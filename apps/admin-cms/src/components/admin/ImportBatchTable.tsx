import React from 'react';
import Link from 'next/link';
import ImportBatchStatusBadge from './ImportBatchStatusBadge';
import { ImportBatchRow } from '../../repositories/ImportBatchRepositoryCore';

export default function ImportBatchTable({ batches }: { batches: ImportBatchRow[] }) {
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
          {batches.map((b) => (
            <tr key={b.id} className="project-row" style={{
              borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
              transition: 'background-color 0.2s',
            }}>
              <td style={{ padding: '1rem 0.5rem' }}>
                <Link href={`/admin/imports/${b.id}`} style={{
                  color: '#3B82F6',
                  fontFamily: 'monospace',
                  textDecoration: 'none',
                  fontWeight: 600
                }}>
                  {b.id.substring(0, 8)}...
                </Link>
              </td>
              <td style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>{b.batch_name}</td>
              <td style={{ padding: '1rem 0.5rem', color: '#D1D5DB' }}><code>{b.source_folder}</code></td>
              <td style={{ padding: '1rem 0.5rem', color: '#9CA3AF' }}>{b.mode}</td>
              <td style={{ padding: '1rem 0.5rem' }}>
                <ImportBatchStatusBadge status={b.status} />
              </td>
              <td style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>{b.total_projects}</td>
              <td style={{ padding: '1rem 0.5rem', textAlign: 'center', color: b.error_count > 0 ? '#EF4444' : '#9CA3AF', fontWeight: b.error_count > 0 ? 600 : 400 }}>
                {b.error_count || 0}
              </td>
              <td style={{ padding: '1rem 0.5rem', textAlign: 'center', color: b.warning_count > 0 ? '#F59E0B' : '#9CA3AF', fontWeight: b.warning_count > 0 ? 600 : 400 }}>
                {b.warning_count || 0}
              </td>
              <td style={{ padding: '1rem 0.5rem', color: '#9CA3AF' }}>
                {new Date(b.created_at).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
