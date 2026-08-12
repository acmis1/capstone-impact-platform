import type { MediaPreviewItem } from '@/components/admin-media/mediaPreviewTypes';

export const sampleMediaPreviewItems: MediaPreviewItem[] = [
  {
    url: 'https://example.com/poster.png',
    fileName: 'poster.png',
    mimeType: 'image/png',
    fileSize: 245760,
    altText: 'Sample PNG project poster',
  },
  {
    url: 'https://example.com/project.jpg',
    fileName: 'project.jpg',
    mimeType: 'image/jpeg',
    fileSize: 512000,
    altText: 'Sample JPEG project image',
  },
  {
    url: 'https://example.com/project.webp',
    fileName: 'project.webp',
    mimeType: 'image/webp',
    fileSize: 180224,
    altText: 'Sample WebP project image',
  },
  {
    url: 'https://example.com/poster.pdf',
    fileName: 'poster.pdf',
    mimeType: 'application/pdf',
    fileSize: 1048576,
  },
  {
    url: undefined,
    fileName: 'missing.png',
    mimeType: 'image/png',
  },
  {
    url: 'not-a-valid-url',
    fileName: 'invalid.jpg',
    mimeType: 'image/jpeg',
  },
  {
    url: 'https://example.com/video.mp4',
    fileName: 'video.mp4',
    mimeType: 'video/mp4',
    fileSize: 5242880,
  },
  {
    url: 'https://example.invalid/broken.png',
    fileName: 'broken.png',
    mimeType: 'image/png',
    altText: 'Broken image preview example',
  },
];