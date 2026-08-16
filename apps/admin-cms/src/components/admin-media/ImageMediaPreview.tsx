'use client';

import { useState } from 'react';

import { MediaFileInfo } from './MediaFileInfo';
import type { MediaPreviewItem } from './mediaPreviewTypes';
import { isValidMediaUrl } from './mediaPreviewUtils';

interface ImageMediaPreviewProps {
  media: MediaPreviewItem;
}

export function ImageMediaPreview({
  media,
}: ImageMediaPreviewProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  if (!media.url) {
    return (
      <div role="status">
        <p>Media file is missing.</p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  if (!isValidMediaUrl(media.url)) {
    return (
      <div role="alert">
        <p>Invalid media URL.</p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  // The authoritative saved text alternative, or nothing at all. A filename-derived string was
  // previously substituted here, which made an undescribed image look described in the Admin view.
  // When no alt text is stored the image is marked decorative for this internal preview and the
  // absence is stated explicitly below, so staff can see there is something to fix.
  const savedAltText = media.altText?.trim() ?? '';

  return (
    <div>
      {isLoading && !hasError && (
        <p role="status">Loading image preview...</p>
      )}

      {hasError ? (
    <div role="alert">
        <p>Image preview could not be loaded.</p>
    </div>
    ) : (
    <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
        src={media.url}
        alt={savedAltText}
        onLoad={() => {
            setIsLoading(false);
        }}
        onError={() => {
            setIsLoading(false);
            setHasError(true);
        }}
          style={{ display: 'block', maxWidth: '100%', height: 'auto', maxHeight: '32rem', objectFit: 'contain' }}
        />
    </>
    )}

    {savedAltText === '' && media.assetType === 'snapshot_image' && (
      <p role="status">Snapshot alt text missing.</p>
    )}

    <MediaFileInfo media={media} />
    </div>
  );
}
