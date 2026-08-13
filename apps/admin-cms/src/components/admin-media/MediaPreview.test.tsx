// @vitest-environment jsdom

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

import { MediaPreview } from './MediaPreview';
import type { MediaPreviewItem } from './mediaPreviewTypes';

afterEach(() => {
  cleanup();
});

describe('MediaPreview', () => {
  it('renders image preview for supported image MIME types', () => {
    const media: MediaPreviewItem = {
      url: 'https://example.com/project.webp',
      fileName: 'project.webp',
      mimeType: 'image/webp',
      fileSize: 2048,
      altText: 'Project WebP preview',
    };

    render(<MediaPreview media={media} />);

    expect(
      screen.getByAltText('Project WebP preview'),
    ).toBeTruthy();
  });

  it('renders PDF preview for application/pdf', () => {
    const media: MediaPreviewItem = {
      url: 'https://example.com/project.pdf',
      fileName: 'project.pdf',
      mimeType: 'application/pdf',
      fileSize: 1048576,
    };

    render(<MediaPreview media={media} />);

    expect(
      screen.getByTitle('PDF preview of project.pdf'),
    ).toBeTruthy();
  });

  it('renders video preview for video/mp4', () => {
    const media: MediaPreviewItem = {
      url: 'https://example.com/project.mp4',
      fileName: 'project.mp4',
      mimeType: 'video/mp4',
      fileSize: 5242880,
      altText: 'Project demonstration video',
      role: 'video',
      position: 1,
    };

    render(<MediaPreview media={media} />);

    expect(
      screen.getByLabelText('Project demonstration video'),
    ).toBeTruthy();

    expect(
      screen.getByText('Loading video preview...'),
    ).toBeTruthy();

    expect(
      screen.getByText('project.mp4'),
    ).toBeTruthy();

    expect(
      screen.getByText('video/mp4'),
    ).toBeTruthy();

    expect(
      screen.getByText('5.0 MB'),
    ).toBeTruthy();
  });

  it('shows unsupported state for unsupported MIME types', () => {
    const media: MediaPreviewItem = {
      url: 'https://example.com/project.zip',
      fileName: 'project.zip',
      mimeType: 'application/zip',
      fileSize: 5242880,
    };

    render(<MediaPreview media={media} />);

    expect(
      screen.getByText('Unsupported media type.'),
    ).toBeTruthy();

    expect(
      screen.getByText('project.zip'),
    ).toBeTruthy();

    expect(
      screen.getByText('application/zip'),
    ).toBeTruthy();

    expect(
      screen.getByText('5.0 MB'),
    ).toBeTruthy();
  });
});