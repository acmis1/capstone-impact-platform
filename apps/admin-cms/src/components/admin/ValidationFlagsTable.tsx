import React from 'react';

export default function ValidationFlagsTable({ flags }: { flags: any[] }) {
  if (!flags || flags.length === 0) {
    return (
      <div style={{ color: '#10B981', padding: '1rem 0', fontSize: '0.9rem', fontWeight: 600 }}>
        ✓ No validation flags recorded. Package meets full staging schema criteria!
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid rgba(255, 255, 255, 0.05)', color: '#9CA3AF' }}>
            <th style={{ padding: '0.75rem 0.5rem' }}>Severity</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Rule Code</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Field Affected</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Validation Message</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {flags.map((f) => {
            const isError = f.severity === 'error';
            return (
              <tr key={f.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                <td style={{ padding: '0.75rem 0.5rem' }}>
                  <span style={{
                    backgroundColor: isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                    color: isError ? '#EF4444' : '#F59E0B',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '4px',
                    fontWeight: 600,
                    fontSize: '0.75rem',
                    display: 'inline-block'
                  }}>
                    {f.severity.toUpperCase()}
                  </span>
                </td>
                <td style={{ padding: '0.75rem 0.5rem', fontFamily: 'monospace', color: '#E5E7EB' }}>
                  {f.rule_code}
                </td>
                <td style={{ padding: '0.75rem 0.5rem', fontFamily: 'monospace', color: '#9CA3AF' }}>
                  {f.field_name || 'n/a'}
                </td>
                <td style={{ padding: '0.75rem 0.5rem', color: '#D1D5DB', lineHeight: '1.4' }}>
                  {f.message}
                </td>
                <td style={{ padding: '0.75rem 0.5rem', color: '#9CA3AF' }}>
                  {f.is_resolved ? '✅ Resolved' : '❌ Staging Pending'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
