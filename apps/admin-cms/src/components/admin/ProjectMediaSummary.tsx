import React from 'react';
import { Project } from '../../domain/project';

interface ProjectMediaSummaryProps {
  project: Project;
}

export function ProjectMediaSummary({ project }: ProjectMediaSummaryProps) {
  const isPosterAvailable = project.poster && project.poster.startsWith('http');
  const isPosterPdfAvailable = project.posterPdf && project.posterPdf.startsWith('http');
  const snapshotsCount = project.snapshots ? project.snapshots.filter(s => s.startsWith('http')).length : 0;

  return (
    <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
        <tbody>
          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal', width: '200px' }}>Poster Preview</th>
            <td style={{ padding: '0.5rem 0' }}>
              {isPosterAvailable ? (
                <div>
                  <span style={{ color: '#10B981', fontWeight: 'bold' }}>✅ Promoted URL Active</span>
                  <div style={{ fontSize: '0.8rem', color: '#9CA3AF', marginTop: '0.25rem', wordBreak: 'break-all' }}>
                    <a href={project.poster} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>
                      {project.poster}
                    </a>
                  </div>
                </div>
              ) : (
                <span style={{ color: '#EF4444', fontWeight: 'bold' }}>❌ Missing Poster Asset</span>
              )}
            </td>
          </tr>

          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Poster Document PDF</th>
            <td style={{ padding: '0.5rem 0' }}>
              {isPosterPdfAvailable ? (
                <div>
                  <span style={{ color: '#10B981', fontWeight: 'bold' }}>✅ Promoted URL Active</span>
                  <div style={{ fontSize: '0.8rem', color: '#9CA3AF', marginTop: '0.25rem', wordBreak: 'break-all' }}>
                    <a href={project.posterPdf} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>
                      {project.posterPdf}
                    </a>
                  </div>
                </div>
              ) : (
                <span style={{ color: '#EF4444', fontWeight: 'bold' }}>❌ Missing PDF Asset</span>
              )}
            </td>
          </tr>

          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Snapshots Count</th>
            <td style={{ padding: '0.5rem 0' }}>
              {snapshotsCount > 0 ? (
                <div>
                  <span style={{ color: '#10B981', fontWeight: 'bold' }}>📸 {snapshotsCount} Snapshots Linked</span>
                  <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem', fontSize: '0.8rem', color: '#9CA3AF' }}>
                    {project.snapshots?.filter(s => s.startsWith('http')).map((snap, i) => (
                      <li key={i} style={{ wordBreak: 'break-all' }}>
                        <a href={snap} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>
                          {snap}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <span style={{ color: '#9CA3AF' }}>None linked</span>
              )}
            </td>
          </tr>

          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Video Showcase</th>
            <td style={{ padding: '0.5rem 0' }}>
              {project.videoUrl ? (
                <a href={project.videoUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>
                  🎥 YouTube/Vimeo Showcase Link ({project.videoUrl})
                </a>
              ) : (
                <span style={{ color: '#9CA3AF' }}>Not provided</span>
              )}
            </td>
          </tr>

          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Interactive Demo</th>
            <td style={{ padding: '0.5rem 0' }}>
              {project.demoUrl ? (
                <a href={project.demoUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>
                  🌐 External Demo URL ({project.demoUrl})
                </a>
              ) : (
                <span style={{ color: '#9CA3AF' }}>Not provided</span>
              )}
            </td>
          </tr>

          <tr>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Git Repository</th>
            <td style={{ padding: '0.5rem 0' }}>
              {project.repositoryUrl ? (
                <a href={project.repositoryUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>
                  💻 GitHub Repository ({project.repositoryUrl})
                </a>
              ) : (
                <span style={{ color: '#9CA3AF' }}>Not provided</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
