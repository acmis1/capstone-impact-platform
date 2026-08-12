import { describe, expect, it } from 'vitest';

import { adaptProjectMedia } from './projectMediaAdapter';

describe('adaptProjectMedia', () => {
  it('preserves the authoritative media_assets projection without deriving legacy project URLs', () => {
    const item = {
      id: 'asset-id', assetType: 'poster_image', fileName: 'poster.png', mimeType: 'image/png',
      fileSize: 2048, url: 'https://example.test/signed-preview', previewSource: 'private-signed' as const,
    };

    expect(adaptProjectMedia([item])).toEqual([item]);
  });
});
