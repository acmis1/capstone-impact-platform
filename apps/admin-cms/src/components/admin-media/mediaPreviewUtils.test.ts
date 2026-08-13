import { describe, expect, it } from 'vitest';

import {
  classifyMediaType,
  formatFileSize,
  isValidMediaUrl,
} from './mediaPreviewUtils';

describe('isValidMediaUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    expect(
      isValidMediaUrl('https://example.com/image.png'),
    ).toBe(true);
  });

  it('accepts valid HTTP URLs', () => {
    expect(
      isValidMediaUrl('http://example.com/image.jpg'),
    ).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(
      isValidMediaUrl('not-a-url'),
    ).toBe(false);
  });

  it('rejects javascript URLs', () => {
    expect(
      isValidMediaUrl('javascript:alert("test")'),
    ).toBe(false);
  });

  it('rejects empty values', () => {
    expect(isValidMediaUrl('')).toBe(false);
    expect(isValidMediaUrl(undefined)).toBe(false);
  });
});

describe('classifyMediaType', () => {
  it('classifies PNG as image', () => {
    expect(
      classifyMediaType('image/png'),
    ).toBe('image');
  });

  it('classifies JPEG as image', () => {
    expect(
      classifyMediaType('image/jpeg'),
    ).toBe('image');
  });

  it('classifies WebP as image', () => {
    expect(
      classifyMediaType('image/webp'),
    ).toBe('image');
  });

  it('classifies PDF as pdf', () => {
    expect(
      classifyMediaType('application/pdf'),
    ).toBe('pdf');
  });

  it('classifies MP4 as video', () => {
    expect(
      classifyMediaType('video/mp4'),
    ).toBe('video');
  });

  it('classifies unsupported MIME types correctly', () => {
    expect(
      classifyMediaType('application/zip'),
    ).toBe('unsupported');
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(
      formatFileSize(500),
    ).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(
      formatFileSize(1024),
    ).toBe('1.0 KB');
  });

  it('formats megabytes', () => {
    expect(
      formatFileSize(1024 * 1024),
    ).toBe('1.0 MB');
  });

  it('handles an unknown file size', () => {
    expect(
      formatFileSize(undefined),
    ).toBe('Unknown size');
  });
});