import type {
  MediaRole,
  ProjectMediaPreviewItem,
} from './mediaPreviewTypes';

function resolveMediaRole(
  media: ProjectMediaPreviewItem,
): MediaRole | undefined {
  const assetType = media.assetType
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');

  const mimeType = media.mimeType
    .toLowerCase()
    .trim();

  if (
    assetType === 'poster_image' ||
    (
      assetType.includes('poster') &&
      mimeType.startsWith('image/')
    )
  ) {
    return 'poster';
  }

  if (
    assetType === 'poster_pdf' ||
    (
      assetType.includes('poster') &&
      mimeType === 'application/pdf'
    )
  ) {
    return 'poster-pdf';
  }

  if (assetType.includes('snapshot')) {
    return 'snapshot';
  }

  if (
    assetType.includes('3d') &&
    mimeType.startsWith('image/')
  ) {
    return '3d-image';
  }

  if (
    assetType.includes('video') ||
    mimeType === 'video/mp4'
  ) {
    return 'video';
  }

  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  return undefined;
}

/**
 * Compatibility boundary for the read-only panel.
 *
 * The incoming items remain the authoritative server-projected
 * media_assets read model. This adapter only adds presentation
 * metadata used by the Admin/CMS frontend.
 */
export function adaptProjectMedia(
  mediaItems: ProjectMediaPreviewItem[],
): ProjectMediaPreviewItem[] {
  const roleCounters: Partial<
    Record<MediaRole, number>
  > = {};

  return mediaItems.map((media) => {
    const role =
      media.role ??
      resolveMediaRole(media);

    if (!role) {
      return media;
    }

    if (
      role === 'poster' ||
      role === 'poster-pdf'
    ) {
      return {
        ...media,
        role,
      };
    }

    const position =
      (roleCounters[role] ?? 0) + 1;

    roleCounters[role] = position;

    return {
      ...media,
      role,
      position,
    };
  });
}