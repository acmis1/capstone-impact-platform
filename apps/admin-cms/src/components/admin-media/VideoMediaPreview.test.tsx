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

import { VideoMediaPreview } from './VideoMediaPreview';
import type { MediaPreviewItem } from './mediaPreviewTypes';

afterEach(() => {
  cleanup();
});

const validVideo: MediaPreviewItem = {
  url: 'https://example.com/project.mp4',
  fileName: 'project.mp4',
  mimeType: 'video/mp4',
  fileSize: 5242880,
  altText: 'Project demonstration video',
  role: 'video',
  position: 1,
};

describe('VideoMediaPreview', () => {
  it('renders a valid video', () => {
    render(
      <VideoMediaPreview media={validVideo} />,
    );

    expect(
      screen.getByLabelText(
        'Project demonstration video',
      ),
    ).toBeTruthy();
  });

  it('shows loading state initially', () => {
    render(
      <VideoMediaPreview media={validVideo} />,
    );

    expect(
      screen.getByText(
        'Loading video preview...',
      ),
    ).toBeTruthy();
  });

  it('removes loading state after metadata loads', () => {
    render(
      <VideoMediaPreview media={validVideo} />,
    );

    const video = screen.getByLabelText(
      'Project demonstration video',
    );

    fireEvent.loadedMetadata(video);

    expect(
      screen.queryByText(
        'Loading video preview...',
      ),
    ).toBeNull();
  });

  it('shows preview error state', () => {
    render(
      <VideoMediaPreview media={validVideo} />,
    );

    const video = screen.getByLabelText(
      'Project demonstration video',
    );

    fireEvent.error(video);

    expect(
      screen.getByText(
        'Video preview could not be loaded.',
      ),
    ).toBeTruthy();
  });

  it('shows missing video state', () => {
    render(
      <VideoMediaPreview
        media={{
          ...validVideo,
          url: undefined,
        }}
      />,
    );

    expect(
      screen.getByText(
        'Video file is missing.',
      ),
    ).toBeTruthy();
  });

  it('rejects invalid video URLs', () => {
    render(
      <VideoMediaPreview
        media={{
          ...validVideo,
          url: 'not-a-valid-url',
        }}
      />,
    );

    expect(
      screen.getByText(
        'Invalid video URL.',
      ),
    ).toBeTruthy();
  });

  it('shows video metadata', () => {
    render(
      <VideoMediaPreview media={validVideo} />,
    );

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
});