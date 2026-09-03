// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../domain/project';
import type { ProjectMediaPreviewItem } from '../admin-media/mediaPreviewTypes';
import { ProjectMediaSummary } from './ProjectMediaSummary';

vi.mock('./SnapshotAltTextGalleryEditor', () => ({
  SnapshotAltTextGalleryEditor: ({
    mediaItems,
  }: {
    mediaItems: ProjectMediaPreviewItem[];
  }) => (
    <div data-testid="snapshot-alt-editor-gallery">
      {mediaItems.map((media) => (
        <div key={media.id} data-testid="snapshot-alt-editor" data-media-asset-id={media.id}>
          {media.altText}
        </div>
      ))}
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

    const editors = screen.getAllByTestId('snapshot-alt-editor');

    expect(editors).toHaveLength(3);

    expect(
      editors[0].compareDocumentPosition(editors[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(
      editors[1].compareDocumentPosition(editors[2]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(editors[0].getAttribute('data-media-asset-id')).toBe('media-a');
    expect(editors[0].textContent).toContain('Alt text for snapshot one.');

    expect(editors[1].getAttribute('data-media-asset-id')).toBe('media-b');
    expect(editors[1].textContent).toContain('Alt text for snapshot two.');

    expect(editors[2].getAttribute('data-media-asset-id')).toBe('media-c');
    expect(editors[2].textContent).toContain('Alt text for snapshot three.');
  });

  it('renders visible media preview tiles in authoritative gallery order', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[
          media({ id: 'poster-image', assetType: 'poster_image', fileName: 'poster.png', altText: 'Poster description.' }),
          media({ id: 'poster-pdf', assetType: 'poster_pdf', fileName: 'poster.pdf', mimeType: 'application/pdf' }),
          media({ id: 'media-a', galleryPosition: 1, fileName: 'snapshot-1.png', altText: 'Snapshot one description.' }),
          media({ id: 'media-b', galleryPosition: 2, fileName: 'snapshot-2.png', altText: 'Snapshot two description.' }),
          media({ id: 'media-c', galleryPosition: 3, fileName: 'snapshot-3.png', altText: 'Snapshot three description.' }),
        ]}
      />,
    );

    const tiles = [
      screen.getByAltText('Poster description.'),
      screen.getByTitle('PDF preview of poster.pdf'),
      screen.getByAltText('Snapshot one description.'),
      screen.getByAltText('Snapshot two description.'),
      screen.getByAltText('Snapshot three description.'),
    ];

    tiles.slice(0, -1).forEach((tile, index) => {
      expect(tile.compareDocumentPosition(tiles[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
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

  it('renders safe controlled project links with the expected labels and link protections', () => {
    render(
      <ProjectMediaSummary
        project={project({
          videoUrl: 'https://video.example.com/watch',
          demoUrl: 'https://demo.example.com/live',
          repositoryUrl: 'https://github.com/example/project',
        })}
        mediaAvailable
        mediaItems={[]}
      />,
    );

    expect(screen.getByText('Video')).toBeTruthy();
    expect(screen.getByText('Live demo / prototype')).toBeTruthy();
    expect(screen.getByText('Repository')).toBeTruthy();

    const video = screen.getByRole('link', { name: 'Open video' });
    const demo = screen.getByRole('link', {
      name: 'Open live demo / prototype',
    });
    const repository = screen.getByRole('link', {
      name: 'Open repository',
    });

    expect(video.getAttribute('href')).toBe(
      'https://video.example.com/watch',
    );
    expect(demo.getAttribute('href')).toBe(
      'https://demo.example.com/live',
    );
    expect(repository.getAttribute('href')).toBe(
      'https://github.com/example/project',
    );

    for (const link of [video, demo, repository]) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/project.html',
    'not-a-url',
  ])('does not render an unsafe controlled URL as a clickable link: %s', (unsafeUrl) => {
    render(
      <ProjectMediaSummary
        project={project({
          videoUrl: unsafeUrl,
        })}
        mediaAvailable
        mediaItems={[]}
      />,
    );

    expect(
      screen.queryByRole('link', { name: 'Open video' }),
    ).toBeNull();

    expect(screen.getAllByText('Not provided').length).toBeGreaterThan(0);
  });

  it('does not interpret controlled project links as arbitrary HTML or embedded content', () => {
    const { container } = render(
      <ProjectMediaSummary
        project={project({
          videoUrl:
            'https://example.com/?value=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
        })}
        mediaAvailable
        mediaItems={[]}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();

    expect(
      screen.getByRole('link', { name: 'Open video' }),
    ).toBeTruthy();
  });
});
