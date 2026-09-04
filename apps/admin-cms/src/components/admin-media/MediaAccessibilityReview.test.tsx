// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MediaAccessibilityReview } from './MediaAccessibilityReview';
import type { ProjectMediaPreviewItem } from './mediaPreviewTypes';

afterEach(() => {
  cleanup();
});

function media(
  overrides: Partial<ProjectMediaPreviewItem> = {},
): ProjectMediaPreviewItem {
  return {
    id: 'asset-1',
    assetType: 'poster_image',
    galleryPosition: null,
    previewSource: 'private-signed',
    url: 'https://example.com/media.png',
    fileName: 'poster.png',
    mimeType: 'image/png',
    fileSize: 2048,
    ...overrides,
  };
}

describe('MediaAccessibilityReview', () => {
  it('wraps the complete filename in its accessibility review label', () => {
    const fileName = 'syntheticfilename'.repeat(5) + '.png';
    render(<MediaAccessibilityReview media={media({ fileName })} />);
    expect(screen.getByText(fileName).classList.contains('break-all')).toBe(true);
  });

  it('reports an available text alternative without duplicating text shown by a valid image preview', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'snapshot_image',
          galleryPosition: 1,
          altText: 'Participants demonstrating the project prototype.',
        })}
      />,
    );

    expect(screen.getByText('Text alternative available')).toBeTruthy();
    expect(screen.queryByText('Participants demonstrating the project prototype.')).toBeNull();
    expect(screen.queryByText('Accessibility information incomplete')).toBeNull();
  });

  it('keeps authoritative alternative text selectable when the image preview is unavailable', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          altText: 'Participants demonstrating the project prototype.',
          previewSource: 'unavailable',
          url: undefined,
        })}
      />,
    );

    expect(screen.getByText('Text alternative available')).toBeTruthy();
    expect(screen.getByText('Participants demonstrating the project prototype.')).toBeTruthy();
  });

  it('clearly reports missing image alternative text', () => {
    render(<MediaAccessibilityReview media={media({ altText: undefined })} />);

    expect(screen.getByText('Accessibility information incomplete')).toBeTruthy();
    expect(screen.getByText('Alternative text is not available for this image.')).toBeTruthy();
  });

  it('shows complete poster image evidence using assetType rather than an inferred role', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'poster_image',
          fileName: 'poster.png',
          altText: 'Poster describing the capstone project.',
        })}
        fullText="Complete searchable poster text."
      />,
    );

    expect(screen.getByText('Text alternative available')).toBeTruthy();
    expect(screen.getByText('Full text available')).toBeTruthy();
    expect(screen.getByText('Complete searchable poster text.')).toBeTruthy();
  });

  it('shows the selectable full-text equivalent for a poster PDF', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'poster_pdf',
          fileName: 'poster.pdf',
          mimeType: 'application/pdf',
          altText: undefined,
        })}
        fullText="Complete poster text describing the project."
      />,
    );

    expect(screen.getByText('Full text available')).toBeTruthy();
    expect(screen.getByText('Complete poster text describing the project.')).toBeTruthy();
    expect(screen.queryByText('Text alternative available')).toBeNull();
  });

  it('clearly reports a missing full-text equivalent', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'poster_pdf',
          fileName: 'poster.pdf',
          mimeType: 'application/pdf',
        })}
      />,
    );

    expect(screen.getByText('Accessibility information incomplete')).toBeTruthy();
    expect(screen.getByText('A full-text equivalent is not available for this poster.')).toBeTruthy();
  });

  it('associates each review with the correct media asset', () => {
  render(
    <>
      <MediaAccessibilityReview
        media={media({
          id: 'poster',
          assetType: 'poster_image',
          galleryPosition: null,
          fileName: 'poster.png',
        })}
        fullText="Poster full text."
      />

      <MediaAccessibilityReview
        media={media({
          id: 'snapshot',
          assetType: 'snapshot_image',
          galleryPosition: 1,
          fileName: 'snapshot.png',
        })}
      />
    </>,
  );

  const posterReview = screen.getByRole('region', {
    name: 'Accessibility review — Poster image: poster.png',
  });

  const snapshotReview = screen.getByRole('region', {
    name: 'Accessibility review — Snapshot image: snapshot.png',
  });

  expect(
    within(posterReview).getByText('Full text available'),
  ).toBeTruthy();

  expect(
    within(snapshotReview).getByText('Accessibility information incomplete'),
  ).toBeTruthy();

  expect(
    within(snapshotReview).queryByText('Poster full text.'),
  ).toBeNull();
});
});