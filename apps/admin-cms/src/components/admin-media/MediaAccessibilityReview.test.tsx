// @vitest-environment jsdom

import React from 'react';

import {
  cleanup,
  render,
  screen,
} from '@testing-library/react';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import { MediaAccessibilityReview } from './MediaAccessibilityReview';
import type { ProjectMediaPreviewItem } from './mediaPreviewTypes';

afterEach(() => {
  cleanup();
});

function media(
  overrides: Partial<ProjectMediaPreviewItem> = {},
): ProjectMediaPreviewItem {
  return {
    id: 'media-1',
    assetType: 'snapshot_image',
    fileName: 'snapshot.png',
    mimeType: 'image/png',
    previewSource: 'public',
    role: 'snapshot',
    ...overrides,
  };
}

describe('MediaAccessibilityReview', () => {
  it('shows an existing image text alternative', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          altText: 'Students demonstrating the project prototype.',
        })}
      />,
    );

    expect(
      screen.getByText('Text alternative available'),
    ).toBeTruthy();

    expect(
      screen.getByText('Students demonstrating the project prototype.'),
    ).toBeTruthy();
  });

  it('clearly reports missing alternative text', () => {
    render(
      <MediaAccessibilityReview
        media={media()}
      />,
    );

    expect(
      screen.getByText('Accessibility information incomplete'),
    ).toBeTruthy();

    expect(
      screen.getByText(
        'Alternative text is not available for this image.',
      ),
    ).toBeTruthy();
  });

  it('shows the full-text equivalent for a poster PDF', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'poster_pdf',
          fileName: 'poster.pdf',
          mimeType: 'application/pdf',
          role: 'poster-pdf',
        })}
        fullText="Complete poster text describing the project."
      />,
    );

    expect(
      screen.getByText('Full text available'),
    ).toBeTruthy();

    expect(
      screen.getByText(
        'Complete poster text describing the project.',
      ),
    ).toBeTruthy();
  });

  it('clearly reports a missing full-text equivalent', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'poster_pdf',
          fileName: 'poster.pdf',
          mimeType: 'application/pdf',
          role: 'poster-pdf',
        })}
      />,
    );

    expect(
      screen.getByText('Accessibility information incomplete'),
    ).toBeTruthy();

    expect(
      screen.getByText(
        'No full-text equivalent is available for this media asset.',
      ),
    ).toBeTruthy();
  });

  it('requires both alternative text and full text for a poster image', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'poster_image',
          fileName: 'poster.png',
          mimeType: 'image/png',
          role: 'poster',
          altText: 'Poster describing the capstone project.',
        })}
      />,
    );

    expect(
      screen.getByText('Accessibility information incomplete'),
    ).toBeTruthy();

    expect(
      screen.getByText(
        'No full-text equivalent is available for this media asset.',
      ),
    ).toBeTruthy();
  });

  it('shows complete accessibility information for a poster image', () => {
    render(
      <MediaAccessibilityReview
        media={media({
          assetType: 'poster_image',
          fileName: 'poster.png',
          mimeType: 'image/png',
          role: 'poster',
          altText: 'Poster describing the capstone project.',
        })}
        fullText="Complete searchable poster text."
      />,
    );

    expect(
      screen.getByText('Full text available'),
    ).toBeTruthy();

    expect(
      screen.getByText(
        'Poster describing the capstone project.',
      ),
    ).toBeTruthy();

    expect(
      screen.getByText(
        'Complete searchable poster text.',
      ),
    ).toBeTruthy();
  });
});