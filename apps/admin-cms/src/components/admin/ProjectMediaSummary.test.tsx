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
  vi,
} from 'vitest';

import type { Project } from '../../domain/project';
import type { ProjectMediaPreviewItem } from '../admin-media/mediaPreviewTypes';

import { ProjectMediaSummary } from './ProjectMediaSummary';

vi.mock('../admin-media/MediaPreview', () => ({
  MediaPreview: ({ media }: { media: ProjectMediaPreviewItem }) => (
    <div>Preview: {media.fileName}</div>
  ),
}));

afterEach(() => {
  cleanup();
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    publicId: 'project-1',
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
    id: 'media-1',
    assetType: 'snapshot_image',
    fileName: 'snapshot.png',
    mimeType: 'image/png',
    previewSource: 'public',
    role: 'snapshot',
    ...overrides,
  };
}

describe('ProjectMediaSummary accessibility integration', () => {
  it('renders accessibility review beside the matching media preview', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[
          media({
            altText: 'Students demonstrating the project prototype.',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Preview: snapshot.png')).toBeTruthy();

    expect(
      screen.getByText('Accessibility review — snapshot.png'),
    ).toBeTruthy();

    expect(
      screen.getByText('Students demonstrating the project prototype.'),
    ).toBeTruthy();
  });

  it('provides poster full text to the poster accessibility review', () => {
    render(
      <ProjectMediaSummary
        project={project({
          posterText: 'Complete poster full text.',
        })}
        mediaAvailable
        mediaItems={[
          media({
            assetType: 'poster_pdf',
            fileName: 'poster.pdf',
            mimeType: 'application/pdf',
            role: 'poster-pdf',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Preview: poster.pdf')).toBeTruthy();
    expect(screen.getByText('Full text available')).toBeTruthy();
    expect(screen.getByText('Complete poster full text.')).toBeTruthy();
  });

  it('preserves the existing unavailable media state', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable={false}
        mediaItems={[]}
      />,
    );

    expect(
      screen.getByText('Media preview temporarily unavailable.'),
    ).toBeTruthy();
  });

  it('preserves the existing empty media state', () => {
    render(
      <ProjectMediaSummary
        project={project()}
        mediaAvailable
        mediaItems={[]}
      />,
    );

    expect(screen.getByText('No media attached.')).toBeTruthy();
  });
});