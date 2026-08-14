// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import { ImageMediaPreview } from './ImageMediaPreview';
import type { MediaPreviewItem } from './mediaPreviewTypes';

afterEach(() => {
  cleanup();
});

const validImage: MediaPreviewItem = {
  url: 'https://example.com/project.png',
  fileName: 'project.png',
  mimeType: 'image/png',
  fileSize: 2048,
  altText: 'Project preview image',
};

describe('ImageMediaPreview', () => {
  it('renders a valid image with alternative text', () => {
    render(<ImageMediaPreview media={validImage} />);

    expect(
      screen.getByAltText('Project preview image'),
    ).toBeTruthy();
  });

  it('shows the loading state initially', () => {
    render(<ImageMediaPreview media={validImage} />);

    expect(
      screen.getByText('Loading image preview...'),
    ).toBeTruthy();
  });

  it('removes loading state after image loads', () => {
    render(<ImageMediaPreview media={validImage} />);

    const image = screen.getByAltText('Project preview image');

    fireEvent.load(image);

    expect(
      screen.queryByText('Loading image preview...'),
    ).toBeNull();
  });

  it('shows preview error when image loading fails', () => {
    render(<ImageMediaPreview media={validImage} />);

    const image = screen.getByAltText('Project preview image');

    fireEvent.error(image);

    expect(
      screen.getByText('Image preview could not be loaded.'),
    ).toBeTruthy();
  });

  it('shows missing-file state when URL is absent', () => {
    render(
      <ImageMediaPreview
        media={{
          ...validImage,
          url: undefined,
        }}
      />,
    );

    expect(
      screen.getByText('Media file is missing.'),
    ).toBeTruthy();
  });

  it('shows invalid URL state', () => {
    render(
      <ImageMediaPreview
        media={{
          ...validImage,
          url: 'not-a-url',
        }}
      />,
    );

    expect(
      screen.getByText('Invalid media URL.'),
    ).toBeTruthy();
  });

  it('displays file metadata', () => {
    render(<ImageMediaPreview media={validImage} />);

    expect(screen.getByText('project.png')).toBeTruthy();
    expect(screen.getByText('image/png')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('never substitutes a filename-derived alternative when no alt text is stored', () => {
    const { container } = render(
      <ImageMediaPreview
        media={{
          ...validImage,
          altText: undefined,
        }}
      />,
    );

    // The old behaviour rendered "Preview of project.png", which described the file rather than the
    // image and made an undescribed asset look described. An empty alt is the honest representation
    // for this internal preview; the absence is reported separately for snapshot media.
    expect(screen.queryByAltText('Preview of project.png')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('states plainly when a snapshot image has no stored alt text', () => {
    render(
      <ImageMediaPreview
        media={{
          ...validImage,
          assetType: 'snapshot_image',
          altText: undefined,
        }}
      />,
    );

    expect(screen.getByText('Snapshot alt text missing.')).toBeTruthy();
  });

  it('renders the stored snapshot alt text as the image alternative when one exists', () => {
    render(
      <ImageMediaPreview
        media={{
          ...validImage,
          assetType: 'snapshot_image',
          altText: 'Dashboard comparing queue lengths before and after adaptive signal timing.',
        }}
      />,
    );

    expect(
      screen.getByAltText('Dashboard comparing queue lengths before and after adaptive signal timing.'),
    ).toBeTruthy();
    expect(screen.queryByText('Snapshot alt text missing.')).toBeNull();
  });
});