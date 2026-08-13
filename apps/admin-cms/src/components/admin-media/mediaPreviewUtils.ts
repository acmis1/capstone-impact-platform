import type { MediaKind } from './mediaPreviewTypes';

export function isValidMediaUrl(value?: string): boolean {
  if (!value || value.trim() === '') {
    return false;
  }

  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function classifyMediaType(mimeType: string): MediaKind {
  const normalizedMimeType = mimeType.toLowerCase().trim();

  if (
    normalizedMimeType === 'image/png' ||
    normalizedMimeType === 'image/jpeg' ||
    normalizedMimeType === 'image/webp'
  ) {
    return 'image';
  }

  if (normalizedMimeType === 'application/pdf') {
    return 'pdf';
  }

  if (normalizedMimeType === 'video/mp4') {
    return 'video';
  }

  return 'unsupported';
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) {
    return 'Unknown size';
  }

  if (bytes < 0 || !Number.isFinite(bytes)) {
    return 'Unknown size';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}