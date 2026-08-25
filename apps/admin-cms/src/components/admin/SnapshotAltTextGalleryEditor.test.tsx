// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectMediaPreviewItem } from '../admin-media/mediaPreviewTypes';
import { SnapshotAltTextGalleryEditor } from './SnapshotAltTextGalleryEditor';

afterEach(() => {
  cleanup();
});

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

describe('SnapshotAltTextGalleryEditor', () => {
  it('shares the successful project version with sequential sibling image saves without overwriting their alt text', async () => {
    const saveAction = vi.fn()
      .mockResolvedValueOnce({ ok: true, snapshot: { publicId: 'project-1', mediaAssetId: 'snapshot-1', snapshotAltText: 'First image description.', expectedUpdatedAt: '2026-08-25T00:00:02.000Z' } })
      .mockResolvedValueOnce({ ok: true, snapshot: { publicId: 'project-1', mediaAssetId: 'snapshot-2', snapshotAltText: 'Second image description.', expectedUpdatedAt: '2026-08-25T00:00:03.000Z' } });

    render(
      <SnapshotAltTextGalleryEditor
        publicId="project-1"
        mediaItems={[snapshot('snapshot-1', 1), snapshot('snapshot-2', 2, 'Existing second image description.')]}
        canEdit
        initialExpectedUpdatedAt="2026-08-25T00:00:01.000Z"
        projectStatus="draft"
        saveAction={saveAction}
      />,
    );

    const firstEditor = screen.getByText('Snapshot 1 alt text').parentElement;
    const secondEditor = screen.getByText('Snapshot 2 alt text').parentElement;
    expect(firstEditor).toBeTruthy();
    expect(secondEditor).toBeTruthy();

    fireEvent.click(within(firstEditor!).getByRole('button', { name: 'Add alt text' }));
    fireEvent.change(within(firstEditor!).getByRole('textbox'), { target: { value: 'First image description.' } });
    fireEvent.click(within(firstEditor!).getByRole('button', { name: 'Save alt text' }));

    await vi.waitFor(() => {
      expect(saveAction).toHaveBeenNthCalledWith(1, {
        publicId: 'project-1', mediaAssetId: 'snapshot-1', snapshotAltText: 'First image description.', expectedUpdatedAt: '2026-08-25T00:00:01.000Z',
      });
    });

    expect(within(firstEditor!).getByText('First image description.')).toBeTruthy();
    expect(within(secondEditor!).getByText('Existing second image description.')).toBeTruthy();

    fireEvent.click(within(secondEditor!).getByRole('button', { name: 'Edit alt text' }));
    fireEvent.change(within(secondEditor!).getByRole('textbox'), { target: { value: 'Second image description.' } });
    fireEvent.click(within(secondEditor!).getByRole('button', { name: 'Save alt text' }));

    await vi.waitFor(() => {
      expect(saveAction).toHaveBeenNthCalledWith(2, {
        publicId: 'project-1', mediaAssetId: 'snapshot-2', snapshotAltText: 'Second image description.', expectedUpdatedAt: '2026-08-25T00:00:02.000Z',
      });
    });

    expect(within(firstEditor!).getByText('First image description.')).toBeTruthy();
    expect(within(secondEditor!).getByText('Second image description.')).toBeTruthy();
  });
});
