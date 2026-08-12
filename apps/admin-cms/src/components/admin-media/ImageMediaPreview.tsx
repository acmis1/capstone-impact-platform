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

  const altText =
    media.altText?.trim() ||
    `Preview of ${media.fileName}`;

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
        alt={altText}
        onLoad={() => {
            setIsLoading(false);
        }}
        onError={() => {
            setIsLoading(false);
            setHasError(true);
        }}
        />
    </>
    )}

    <MediaFileInfo media={media} />
    </div>
  );
}