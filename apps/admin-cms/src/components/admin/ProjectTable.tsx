import React from 'react';
import { Project } from '../../domain/project';
import { ProjectStatusBadge } from './ProjectStatusBadge';

interface ProjectTableProps {
  projects: Project[];
}

export function ProjectTable({ projects }: ProjectTableProps) {
  if (projects.length === 0) {
    return (
      <div style={{
        padding: '3rem',
        textAlign: 'center',
        backgroundColor: '#1E293B',
        borderRadius: '12px',
        border: '1px dashed rgba(255, 255, 255, 0.1)',
        marginTop: '1.5rem',
      }}>
        <h3 style={{ margin: '0 0 1rem 0', color: '#F3F4F6' }}>No Staging Projects Found</h3>
        <p style={{ margin: '0 0 2rem 0', color: '#9CA3AF', fontSize: '0.95rem', lineHeight: '1.6' }}>
          The staging projects database is empty. You can easily populate and audit the database by executing these commands in your workspace terminal:
        </p>
        <pre style={{
          backgroundColor: '#0F172A',
          padding: '1rem',
          borderRadius: '8px',
          color: '#34D399',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.9rem',
          display: 'inline-block',
          textAlign: 'left',
          maxWidth: '500px',
          width: '100%',
          overflowX: 'auto',
          margin: '0 auto',
        }}>
          # 1. Seed mock projects<br />
          npm run seed:staging<br /><br />
          # 2. Ingest and promote fake media<br />
          npm run seed:staging-media<br /><br />
          # 3. Publish approved-only JSON feed<br />
          npm run publish:staging-feed
        </pre>
      </div>
    );
  }

  return (
    <div style={{
      overflowX: 'auto',
      backgroundColor: '#161F30',
      borderRadius: '12px',
      border: '1px solid rgba(255, 255, 255, 0.05)',
      marginTop: '1.5rem',
    }}>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        textAlign: 'left',
        fontSize: '0.9rem',
        color: '#D1D5DB',
      }}>
        <thead>
          <tr style={{
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            backgroundColor: '#1E293B',
          }}>
            <th style={{ padding: '1rem 1.5rem', fontWeight: '600', color: '#9CA3AF' }}>Project Details</th>
            <th style={{ padding: '1rem 1.5rem', fontWeight: '600', color: '#9CA3AF' }}>Status</th>
            <th style={{ padding: '1rem 1.5rem', fontWeight: '600', color: '#9CA3AF' }}>Attributes</th>
            <th style={{ padding: '1rem 1.5rem', fontWeight: '600', color: '#9CA3AF' }}>Assets</th>
            <th style={{ padding: '1rem 1.5rem', fontWeight: '600', color: '#9CA3AF', textAlign: 'center' }}>Public Feed</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const isApproved = p.status === 'approved' || p.status === 'published';
            const isPosterAvailable = p.poster && p.poster.startsWith('http');
            const isPosterPdfAvailable = p.posterPdf && p.posterPdf.startsWith('http');
            const snapshotsCount = p.snapshots ? p.snapshots.filter(s => s.startsWith('http')).length : 0;

            return (
              <tr key={p.publicId} style={{
                borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                transition: 'background-color 0.2s',
              }}
              className="project-row"
              >
                {/* 1. Project Details */}
                <td style={{ padding: '1.25rem 1.5rem' }}>
                  <div style={{ fontWeight: '700', color: '#FFFFFF', marginBottom: '0.25rem' }}>{p.title}</div>
                  <div style={{ fontSize: '0.8rem', color: '#9CA3AF' }}>
                    <code style={{ backgroundColor: '#1E293B', padding: '0.15rem 0.35rem', borderRadius: '4px', color: '#F59E0B' }}>{p.publicId}</code>
                  </div>
                </td>

                {/* 2. Status */}
                <td style={{ padding: '1.25rem 1.5rem', verticalAlign: 'middle' }}>
                  <ProjectStatusBadge status={p.status} />
                </td>

                {/* 3. Attributes */}
                <td style={{ padding: '1.25rem 1.5rem', fontSize: '0.85rem' }}>
                  <div><strong>Year:</strong> {p.year || 'N/A'}</div>
                  <div style={{ color: '#9CA3AF' }}><strong>Program:</strong> {p.program || 'N/A'}</div>
                  <div style={{ color: '#9CA3AF' }}><strong>Discipline:</strong> {p.discipline || 'N/A'}</div>
                </td>

                {/* 4. Assets */}
                <td style={{ padding: '1.25rem 1.5rem', fontSize: '0.85rem' }}>
                  <div>
                    Poster:{' '}
                    <span style={{ color: isPosterAvailable ? '#10B981' : '#EF4444', fontWeight: 'bold' }}>
                      {isPosterAvailable ? '✅ Active' : '❌ None'}
                    </span>
                  </div>
                  <div>
                    PDF:{' '}
                    <span style={{ color: isPosterPdfAvailable ? '#10B981' : '#EF4444', fontWeight: 'bold' }}>
                      {isPosterPdfAvailable ? '✅ Active' : '❌ None'}
                    </span>
                  </div>
                  <div>
                    Snapshots:{' '}
                    <span style={{ color: snapshotsCount > 0 ? '#10B981' : '#9CA3AF', fontWeight: 'bold' }}>
                      {snapshotsCount > 0 ? `📸 ${snapshotsCount}` : 'None'}
                    </span>
                  </div>
                </td>

                {/* 5. Public Eligibility Yes/No */}
                <td style={{ padding: '1.25rem 1.5rem', textAlign: 'center', verticalAlign: 'middle' }}>
                  {isApproved ? (
                    <span style={{
                      backgroundColor: 'rgba(16, 185, 129, 0.1)',
                      color: '#10B981',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      padding: '0.25rem 0.5rem',
                      borderRadius: '4px',
                      fontSize: '0.8rem',
                      fontWeight: 'bold'
                    }}>
                      YES
                    </span>
                  ) : (
                    <span style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.1)',
                      color: '#EF4444',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      padding: '0.25rem 0.5rem',
                      borderRadius: '4px',
                      fontSize: '0.8rem',
                      fontWeight: 'bold'
                    }}>
                      NO
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
