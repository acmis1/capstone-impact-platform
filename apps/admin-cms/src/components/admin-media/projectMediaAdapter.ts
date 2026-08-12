import type { ProjectMediaPreviewItem } from './mediaPreviewTypes';

/**
 * Compatibility boundary for the read-only panel. Its input is already an authoritative,
 * server-projected media_assets read model; legacy project URL fields are intentionally excluded.
 */
export function adaptProjectMedia(mediaItems: ProjectMediaPreviewItem[]): ProjectMediaPreviewItem[] {
  return mediaItems;
}
