// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../domain/project';
import type { ProjectMediaPreviewItem } from '../admin-media/mediaPreviewTypes';
import { ProjectMediaSummary } from './ProjectMediaSummary';

vi.mock('./SnapshotAltTextEditor', () => ({
  SnapshotAltTextEditor: ({
    mediaAssetId,
    initialAltText,
  }: {
    mediaAssetId: string;
    initialAltText: string;
  }) => (
    <div
      data-testid="snapshot-alt-editor"
      data-media-asset-id={mediaAssetId}
    >
      {initialAltText}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    publicId: '2026-accessibility-review',
    posterText: 'Complete poster full text.',
    videoUrl: '',
    demoUrl: '',
    repositoryUrl: '',
    status: 'draft',
    ...overrides,
  } as Project;
}

function media(
  overrides: Partial<ProjectMediaPreviewItem> = {},
): ProjectMediaPreviewItem {
  return {
    id: 'snapshot-1',
    assetType: 'snapshot_image',
    galleryPosition: null,
    fileName: 'snapshot.png',
    mimeType: 'image/png',
    previewSource: 'public',
    url: 'https://example.com/snapshot.png',
    ...overrides,
  };
}

describe('ProjectMediaSummary accessibility integration', () => {
  it('shows complete poster-image accessibility evidence without duplicating saved alt text', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[media({
          id: 'poster-image',
          assetType: 'poster_image',
          fileName: 'poster.png',
          altText: 'Poster showing a project architecture diagram.',
        })]}
      />,
    );

    expect(screen.getByText('Text alternative available')).toBeTruthy();
    expect(screen.getByText('Full text available')).toBeTruthy();
    expect(screen.getAllByText('Poster showing a project architecture diagram.')).toHaveLength(1);
    expect(screen.getByText('Complete poster full text.')).toBeTruthy();
  });

  it('shows missing alternative text for an image while preserving the image preview', () => {
    const { container } = render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[media({ altText: undefined })]}
      />,
    );

    expect(container.querySelector('img')).toBeTruthy();
    expect(screen.getByText('Accessibility information incomplete')).toBeTruthy();
    expect(screen.getByText('Alternative text is not available for this image.')).toBeTruthy();
  });

  it('shows a poster PDF with its full-text equivalent', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[media({
          id: 'poster-pdf',
          assetType: 'poster_pdf',
          fileName: 'poster.pdf',
          mimeType: 'application/pdf',
          url: 'https://example.com/poster.pdf',
        })]}
      />,
    );

    expect(screen.getByTitle('PDF preview of poster.pdf')).toBeTruthy();
    expect(screen.getByText('Full text available')).toBeTruthy();
    expect(screen.getByText('Complete poster full text.')).toBeTruthy();
  });

  it('shows missing full text against the matching poster asset only', () => {
    render(
      <ProjectMediaSummary
        project={project({ posterText: '  ' })}
        mediaAvailable
        mediaItems={[
          media({ id: 'poster-pdf', assetType: 'poster_pdf', fileName: 'poster.pdf', mimeType: 'application/pdf' }),
          media({ id: 'snapshot', fileName: 'snapshot.png', altText: 'Snapshot alt text.' }),
        ]}
      />,
    );

    const pdfReview = screen.getByRole('region', { name: 'Accessibility review — Poster PDF: poster.pdf' });
    const snapshotReview = screen.getByRole('region', { name: 'Accessibility review — Snapshot image: snapshot.png' });

    expect(within(pdfReview).getByText('A full-text equivalent is not available for this poster.')).toBeTruthy();
    expect(within(snapshotReview).queryByText('A full-text equivalent is not available for this poster.')).toBeNull();
  });

  it('keeps saved alt text visible when the corresponding image file is unavailable', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[media({
          altText: 'Authoritative snapshot description.',
          previewSource: 'unavailable',
          url: undefined,
        })]}
      />,
    );

    expect(screen.getByText('Media file is missing.')).toBeTruthy();
    expect(screen.getByText('Text alternative available')).toBeTruthy();
    expect(screen.getByText('Authoritative snapshot description.')).toBeTruthy();
  });

  it('renders snapshot alt-text editors in deterministic gallery order and binds each editor to the correct media asset', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[
          media({
            id: 'media-c',
            galleryPosition: 3,
            fileName: 'snapshot-3.png',
            altText: 'Alt text for snapshot three.',
          }),
          media({
            id: 'media-a',
            galleryPosition: 1,
            fileName: 'snapshot-1.png',
            altText: 'Alt text for snapshot one.',
          }),
          media({
            id: 'media-b',
            galleryPosition: 2,
            fileName: 'snapshot-2.png',
            altText: 'Alt text for snapshot two.',
          }),
        ]}
        snapshotAltText={{
          canEdit: true,
          expectedUpdatedAt: '2026-08-24T00:00:00.000Z',
          saveAction: vi.fn(),
        }}
      />,
    );

    const labels = [
      screen.getByText('Snapshot 1 alt text'),
      screen.getByText('Snapshot 2 alt text'),
      screen.getByText('Snapshot 3 alt text'),
    ];

    expect(
      labels[0].compareDocumentPosition(labels[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(
      labels[1].compareDocumentPosition(labels[2]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const editors = screen.getAllByTestId('snapshot-alt-editor');

    expect(editors).toHaveLength(3);

    expect(editors[0].getAttribute('data-media-asset-id')).toBe('media-a');
    expect(editors[0].textContent).toContain('Alt text for snapshot one.');

    expect(editors[1].getAttribute('data-media-asset-id')).toBe('media-b');
    expect(editors[1].textContent).toContain('Alt text for snapshot two.');

    expect(editors[2].getAttribute('data-media-asset-id')).toBe('media-c');
    expect(editors[2].textContent).toContain('Alt text for snapshot three.');
  });

  it('preserves the empty media state', () => {
    render(<ProjectMediaSummary project={project()} mediaAvailable mediaItems={[]} />);

    expect(screen.getByText('No media attached to this project.')).toBeTruthy();
    expect(screen.queryByText(/Accessibility review/)).toBeNull();
  });

  it('preserves the unavailable media state', () => {
    render(<ProjectMediaSummary project={project()} mediaAvailable={false} mediaItems={[]} />);

    expect(screen.getByRole('status').textContent).toContain('Media preview temporarily unavailable.');
    expect(screen.queryByText(/Accessibility review/)).toBeNull();
  });
});
