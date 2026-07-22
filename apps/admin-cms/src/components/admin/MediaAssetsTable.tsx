import React from 'react';

export interface MediaAssetRow {
  id: string;
  file_name: string;
  asset_type: string;
  storage_bucket: string;
  storage_path: string;
  is_public_approved?: boolean;
  public_url?: string | null;
}

export default function MediaAssetsTable({ assets }: { assets: Array<MediaAssetRow | Record<string, unknown>> }) {
  if (!assets || assets.length === 0) {
    return (
      <div style={{ padding: '1rem 0', color: '#9CA3AF', fontSize: '0.9rem' }}>
        No staging media files registered for this project.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid rgba(255, 255, 255, 0.05)', color: '#9CA3AF' }}>
            <th style={{ padding: '0.75rem 0.5rem' }}>File Name</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Asset Type</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Storage Bucket</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Storage Path Prefix</th>
            <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>Public Approved</th>
            <th style={{ padding: '0.75rem 0.5rem' }}>Showcase Public URL</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => {
            const id = String(a.id || '');
            const fileName = String(a.file_name || '');
            const assetType = String(a.asset_type || '');
            const storageBucket = String(a.storage_bucket || '');
            const storagePath = String(a.storage_path || '');
            const isApproved = Boolean(a.is_public_approved);
            const publicUrl = a.public_url ? String(a.public_url) : null;

            return (
              <tr key={id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                <td style={{ padding: '0.75rem 0.5rem', fontWeight: 600, color: '#E5E7EB' }}>
                  {fileName}
                </td>
                <td style={{ padding: '0.75rem 0.5rem', color: '#9CA3AF' }}>
                  <code>{assetType}</code>
                </td>
                <td style={{ padding: '0.75rem 0.5rem', color: '#9CA3AF' }}>
                  <code>{storageBucket}</code>
                </td>
                <td style={{ padding: '0.75rem 0.5rem', color: '#9CA3AF', fontFamily: 'monospace' }}>
                  {storagePath}
                </td>
                <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>
                  <span style={{
                    color: isApproved ? '#10B981' : '#EF4444',
                    fontWeight: 600
                  }}>
                    {isApproved ? 'YES' : 'NO (Draft)'}
                  </span>
                </td>
                <td style={{ padding: '0.75rem 0.5rem' }}>
                  {publicUrl ? (
                    <a href={publicUrl} target="_blank" rel="noreferrer" style={{
                      color: '#3B82F6',
                      textDecoration: 'none',
                      fontWeight: 600
                    }}>
                      View Public Asset
                    </a>
                  ) : (
                    <span style={{ color: '#6B7280', fontStyle: 'italic' }}>
                      Hidden (Private Draft Bucket)
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
