import { describe, expect, it } from 'vitest';

import { adaptProjectMedia } from './projectMediaAdapter';
import type { ProjectMediaPreviewItem } from './mediaPreviewTypes';

describe('adaptProjectMedia', () => {
  it('preserves the authoritative media_assets projection and adds the poster role', () => {
    const item: ProjectMediaPreviewItem = {
      id: 'asset-id',
      assetType: 'poster_image',
      fileName: 'poster.png',
      mimeType: 'image/png',
      fileSize: 2048,
      url: 'https://example.test/signed-preview',
      previewSource: 'private-signed',
    };

    expect(adaptProjectMedia([item])).toEqual([
      {
        ...item,
        role: 'poster',
      },
    ]);
  });

  it('assigns positions to repeatable image roles', () => {
    const items: ProjectMediaPreviewItem[] = [
      {
        id: 'image-1',
        assetType: 'image',
        fileName: 'image-1.png',
        mimeType: 'image/png',
        url: 'https://example.test/image-1.png',
        previewSource: 'public',
      },
      {
        id: 'image-2',
        assetType: 'image',
        fileName: 'image-2.jpg',
        mimeType: 'image/jpeg',
        url: 'https://example.test/image-2.jpg',
        previewSource: 'public',
      },
      {
        id: 'image-3',
        assetType: 'image',
        fileName: 'image-3.webp',
        mimeType: 'image/webp',
        url: 'https://example.test/image-3.webp',
        previewSource: 'public',
      },
    ];

    const result = adaptProjectMedia(items);

    expect(result[0].role).toBe('image');
    expect(result[0].position).toBe(1);

    expect(result[1].role).toBe('image');
    expect(result[1].position).toBe(2);

    expect(result[2].role).toBe('image');
    expect(result[2].position).toBe(3);
  });

  it('assigns the video role to MP4 media', () => {
    const item: ProjectMediaPreviewItem = {
      id: 'video-1',
      assetType: 'video',
      fileName: 'demo.mp4',
      mimeType: 'video/mp4',
      url: 'https://example.test/demo.mp4',
      previewSource: 'public',
    };

    expect(adaptProjectMedia([item])).toEqual([
      {
        ...item,
        role: 'video',
        position: 1,
      },
    ]);
  });
});