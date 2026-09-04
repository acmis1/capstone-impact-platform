'use client';

import type { ProjectMediaPreviewItem } from '../admin-media/mediaPreviewTypes';
import type { SnapshotAltTextActionResult } from '../../projects/snapshotAltText';
import { SnapshotAltTextEditor } from './SnapshotAltTextEditor';

interface SnapshotAltTextGalleryEditorProps {
  publicId: string;
  mediaItems: ProjectMediaPreviewItem[];
  canEdit: boolean;
  initialExpectedUpdatedAt: string;
  projectStatus: string;
  saveAction: (rawInput: unknown) => Promise<SnapshotAltTextActionResult>;
}

/**
 * Read-only project-team descriptions in authoritative gallery order.
 */
export function SnapshotAltTextGalleryEditor({
  publicId,
  mediaItems,
  canEdit,
  initialExpectedUpdatedAt,
  projectStatus,
  saveAction,
}: SnapshotAltTextGalleryEditorProps) {
  return (
    <div className="border-t border-border pt-4">
      <div className="flex flex-col gap-4">
        {mediaItems.map((media) => (
          <div key={media.id} className="rounded-lg border border-border p-3">
            <p className="mb-2 text-sm font-semibold text-foreground">
              Snapshot {media.galleryPosition ?? 'order unavailable'} alt text
            </p>

            <SnapshotAltTextEditor
              publicId={publicId}
              mediaAssetId={media.id}
              initialAltText={media.altText ?? ''}
              expectedUpdatedAt={initialExpectedUpdatedAt}
              canEdit={canEdit}
              projectStatus={projectStatus}
              saveAction={saveAction}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
