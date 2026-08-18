import React from 'react';

import { Project } from '../../domain/project';
import { MediaPreview } from '../admin-media/MediaPreview';
import type { ProjectMediaPreviewItem } from '../admin-media/mediaPreviewTypes';
import { isValidMediaUrl } from '../admin-media/mediaPreviewUtils';
import { SnapshotAltTextEditor } from './SnapshotAltTextEditor';
import type { SnapshotAltTextActionResult } from '../../projects/snapshotAltText';
import { ExternalLink as ExternalLinkIcon, Video, Globe, Code2 } from 'lucide-react';

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
  if (!isValidMediaUrl(url)) return <span className="text-sm text-muted-foreground">Not provided</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-[32px] items-center gap-1.5 text-sm font-medium text-foreground underline decoration-border-strong underline-offset-4 wrap-anywhere hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span>{label}</span>
      <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
    </a>
  );
}

/** Uploaded-file media is authoritative; project URLs below remain external showcase links. */
export function ProjectMediaSummary({ project, mediaItems, mediaAvailable, snapshotAltText }: ProjectMediaSummaryProps) {
  // The media uniqueness contract allows at most one snapshot image per project today; the editor
  // is rendered against that single asset rather than assuming a gallery.
  const snapshotMedia = mediaItems.find((media) => media.assetType === 'snapshot_image');

  return (
    <div className="flex flex-col gap-5 text-sm">
      {!mediaAvailable ? (
        <p role="status" className="text-sm text-muted-foreground">Media preview temporarily unavailable.</p>
      ) : mediaItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No media attached to this project.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {mediaItems.map((media) => (
            <MediaPreview key={media.id} media={media} />
          ))}
        </div>
      )}

      {mediaAvailable && snapshotMedia && snapshotAltText && (
        <div className="border-t border-border pt-4">
          <SnapshotAltTextEditor
            publicId={project.publicId || ''}
            initialAltText={snapshotMedia.altText ?? ''}
            initialExpectedUpdatedAt={snapshotAltText.expectedUpdatedAt}
            canEdit={snapshotAltText.canEdit}
            projectStatus={project.status}
            saveAction={snapshotAltText.saveAction}
          />
        </div>
      )}

      {/* External Showcase Links */}
      <div className="border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-foreground">External showcase links</h4>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Video className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
              Video Showcase
            </dt>
            <dd className="min-w-0">
              <ExternalLink label="Video showcase link" url={project.videoUrl} />
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Globe className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
              Interactive Demo
            </dt>
            <dd className="min-w-0">
              <ExternalLink label="External demo" url={project.demoUrl} />
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Code2 className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
              Git Repository
            </dt>
            <dd className="min-w-0">
              <ExternalLink label="Git repository" url={project.repositoryUrl} />
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
