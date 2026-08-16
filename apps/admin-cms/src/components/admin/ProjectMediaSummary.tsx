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
  if (!isValidMediaUrl(url)) return <span className="text-muted-foreground">Not provided</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline font-medium break-all"
    >
      <span>{label}</span>
      <ExternalLinkIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

/** Uploaded-file media is authoritative; project URLs below remain external showcase links. */
export function ProjectMediaSummary({ project, mediaItems, mediaAvailable, snapshotAltText }: ProjectMediaSummaryProps) {
  // The media uniqueness contract allows at most one snapshot image per project today; the editor
  // is rendered against that single asset rather than assuming a gallery.
  const snapshotMedia = mediaItems.find((media) => media.assetType === 'snapshot_image');

  return (
    <div className="flex flex-col gap-5 text-xs sm:text-sm">
      {!mediaAvailable ? (
        <p role="status" className="text-muted-foreground">Media preview temporarily unavailable.</p>
      ) : mediaItems.length === 0 ? (
        <p className="text-muted-foreground">No media attached to this project.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {mediaItems.map((media) => (
            <MediaPreview key={media.id} media={media} />
          ))}
        </div>
      )}

      {mediaAvailable && snapshotMedia && snapshotAltText && (
        <div className="pt-3 border-t border-border">
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
      <div className="pt-3 border-t border-border">
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2.5">
          External Showcase Links
        </h4>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-2.5 rounded-md bg-muted/40 border border-border">
            <dt className="text-muted-foreground font-medium flex items-center gap-1.5 mb-1">
              <Video className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              Video Showcase
            </dt>
            <dd>
              <ExternalLink label="Video showcase link" url={project.videoUrl} />
            </dd>
          </div>

          <div className="p-2.5 rounded-md bg-muted/40 border border-border">
            <dt className="text-muted-foreground font-medium flex items-center gap-1.5 mb-1">
              <Globe className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              Interactive Demo
            </dt>
            <dd>
              <ExternalLink label="External demo" url={project.demoUrl} />
            </dd>
          </div>

          <div className="p-2.5 rounded-md bg-muted/40 border border-border">
            <dt className="text-muted-foreground font-medium flex items-center gap-1.5 mb-1">
              <Code2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              Git Repository
            </dt>
            <dd>
              <ExternalLink label="Git repository" url={project.repositoryUrl} />
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
