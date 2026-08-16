import React from 'react';

import { Project } from '../../domain/project';
import { MediaPreview } from '@/components/admin-media/MediaPreview';
import type { ProjectMediaPreviewItem } from '@/components/admin-media/mediaPreviewTypes';
import { isValidMediaUrl } from '@/components/admin-media/mediaPreviewUtils';
import { SnapshotAltTextEditor } from './SnapshotAltTextEditor';
import type { SnapshotAltTextActionResult } from '../../projects/snapshotAltText';

interface ProjectMediaSummaryProps {
  project: Project;
  mediaItems: ProjectMediaPreviewItem[];
  mediaAvailable: boolean;
  /**
   * Snapshot alt-text editing context. Omitted when the project detail page could not resolve a
   * project version to edit against, in which case the value stays read-only rather than offering
   * a save that would immediately fail as stale.
   */
  snapshotAltText?: {
    canEdit: boolean;
    expectedUpdatedAt: string;
    saveAction: (rawInput: unknown) => Promise<SnapshotAltTextActionResult>;
  };
}

function ExternalLink({ label, url }: { label: string; url: string }) {
  if (!isValidMediaUrl(url)) return <span style={{ color: '#9CA3AF' }}>Not provided</span>;
  return <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#3B82F6', textDecoration: 'none' }}>{label}</a>;
}

/** Uploaded-file media is authoritative; project URLs below remain external showcase links. */
export function ProjectMediaSummary({ project, mediaItems, mediaAvailable, snapshotAltText }: ProjectMediaSummaryProps) {
  // The media uniqueness contract allows at most one snapshot image per project today; the editor
  // is rendered against that single asset rather than assuming a gallery.
  const snapshotMedia = mediaItems.find((media) => media.assetType === 'snapshot_image');

  return (
    <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
      {!mediaAvailable ? <p role="status">Media preview temporarily unavailable.</p>
        : mediaItems.length === 0 ? <p>No media attached.</p>
          : mediaItems.map((media) => <MediaPreview key={media.id} media={media} />)}

      {mediaAvailable && snapshotMedia && snapshotAltText && (
        <SnapshotAltTextEditor
          publicId={project.publicId || ''}
          initialAltText={snapshotMedia.altText ?? ''}
          initialExpectedUpdatedAt={snapshotAltText.expectedUpdatedAt}
          canEdit={snapshotAltText.canEdit}
          projectStatus={project.status}
          saveAction={snapshotAltText.saveAction}
        />
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
        <tbody>
          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal', width: '200px' }}>Video Showcase</th>
            <td style={{ padding: '0.5rem 0' }}><ExternalLink label="Video showcase link" url={project.videoUrl} /></td>
          </tr>
          <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Interactive Demo</th>
            <td style={{ padding: '0.5rem 0' }}><ExternalLink label="External demo" url={project.demoUrl} /></td>
          </tr>
          <tr>
            <th style={{ padding: '0.5rem 0', color: '#9CA3AF', fontWeight: 'normal' }}>Git Repository</th>
            <td style={{ padding: '0.5rem 0' }}><ExternalLink label="Git repository" url={project.repositoryUrl} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
