import { describe, expect, it } from 'vitest';

import { adaptProjectMedia } from './projectMediaAdapter';

describe('adaptProjectMedia', () => {
  it('adapts PNG poster media', () => {
    const result = adaptProjectMedia({
      title: 'Test Project',
      poster: 'https://example.com/media/poster.png',
      posterPdf: '',
      snapshots: [],
      accessibilityText: 'Accessible poster description',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fileName: 'poster.png',
      mimeType: 'image/png',
      altText: 'Accessible poster description',
    });
  });

  it('adapts JPEG and WebP snapshots', () => {
    const result = adaptProjectMedia({
      title: 'Test Project',
      poster: '',
      posterPdf: '',
      snapshots: [
        'https://example.com/photo.jpeg',
        'https://example.com/photo.webp',
      ],
      accessibilityText: '',
    });

    expect(result[0].mimeType).toBe('image/jpeg');
    expect(result[1].mimeType).toBe('image/webp');
  });

  it('adapts a PDF poster', () => {
    const result = adaptProjectMedia({
      title: 'Test Project',
      poster: '',
      posterPdf: 'https://example.com/poster.pdf',
      snapshots: [],
      accessibilityText: '',
    });

    expect(result[0]).toMatchObject({
      fileName: 'poster.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('marks unknown extensions as unsupported', () => {
    const result = adaptProjectMedia({
      title: 'Test Project',
      poster: 'https://example.com/file.mp4',
      posterPdf: '',
      snapshots: [],
      accessibilityText: '',
    });

    expect(result[0].mimeType).toBe('application/octet-stream');
  });

  it('handles URLs with query parameters', () => {
    const result = adaptProjectMedia({
      title: 'Test Project',
      poster: 'https://example.com/poster.jpg?version=2',
      posterPdf: '',
      snapshots: [],
      accessibilityText: '',
    });

    expect(result[0]).toMatchObject({
      fileName: 'poster.jpg',
      mimeType: 'image/jpeg',
    });
  });
});