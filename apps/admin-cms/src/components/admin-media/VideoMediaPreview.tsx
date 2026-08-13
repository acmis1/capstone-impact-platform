'use client';

import { useState } from 'react';

import { MediaFileInfo } from './MediaFileInfo';
import type { MediaPreviewItem } from './mediaPreviewTypes';
import { isValidMediaUrl } from './mediaPreviewUtils';

interface VideoMediaPreviewProps {
  media: MediaPreviewItem;
}

export function VideoMediaPreview({
  media,
}: VideoMediaPreviewProps) {
  const [isLoading, setIsLoading] =
    useState(true);
  const [hasError, setHasError] =
    useState(false);

  if (!media.url) {
    return (
      <div role="status">
        <p>Video file is missing.</p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  if (!isValidMediaUrl(media.url)) {
    return (
      <div role="alert">
        <p>Invalid video URL.</p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  const label =
    media.altText?.trim() ||
    `Video preview of ${media.fileName}`;

  return (
    <div>
      {isLoading && !hasError && (
        <p role="status">
          Loading video preview...
        </p>
      )}

      {hasError ? (
        <div role="alert">
          <p>
            Video preview could not be loaded.
          </p>
        </div>
      ) : (
        <video
          src={media.url}
          controls
          preload="metadata"
          playsInline
          aria-label={label}
          onLoadedMetadata={() => {
            setIsLoading(false);
          }}
          onError={() => {
            setIsLoading(false);
            setHasError(true);
          }}
          style={{
            maxWidth: '100%',
            height: 'auto',
          }}
        >
          Your browser does not support
          video playback.
        </video>
      )}

      <MediaFileInfo media={media} />
    </div>
  );
}