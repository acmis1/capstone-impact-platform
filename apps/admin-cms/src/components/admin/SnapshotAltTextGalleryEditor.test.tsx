// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectMediaPreviewItem } from '../admin-media/mediaPreviewTypes';
import { SnapshotAltTextGalleryEditor } from './SnapshotAltTextGalleryEditor';
afterEach(cleanup);
function snapshot(id: string, position: number, altText = ''): ProjectMediaPreviewItem {
  return {
    id,
    assetType: 'snapshot_image',
    galleryPosition: position,
    fileName: `snapshot-${position}.png`,
    mimeType: 'image/png',
    altText,
    previewSource: 'public',
  };
}


describe('SnapshotAltTextGalleryEditor participant ownership', () => {
  it('preserves each description and gallery identity without an editing control', () => {
    const saveAction = vi.fn();
    const { container } = render(<SnapshotAltTextGalleryEditor publicId="project-1" mediaItems={[snapshot('snapshot-1', 1, 'First description.'), snapshot('snapshot-2', 2, 'Second description.')]} canEdit initialExpectedUpdatedAt="2026-08-25T00:00:01.000Z" projectStatus="changes_requested" saveAction={saveAction} />);
    expect(screen.getByText('Snapshot 1 alt text')).toBeTruthy();
    expect(screen.getByText('Snapshot 2 alt text')).toBeTruthy();
    expect(screen.getByText('First description.')).toBeTruthy();
    expect(screen.getByText('Second description.')).toBeTruthy();
    expect(container.querySelector('input, textarea, button')).toBeNull();
    expect(saveAction).not.toHaveBeenCalled();
  });
});
