'use client';

import { useState } from 'react';
import { AlertTriangle, FileWarning, ImageOff } from 'lucide-react';

import { MediaFileInfo } from './MediaFileInfo';
import type { MediaPreviewItem } from './mediaPreviewTypes';
import { isValidMediaUrl } from './mediaPreviewUtils';
import { MEDIA_PREVIEW_CLASSES } from './mediaPreviewStyles';

interface ImageMediaPreviewProps {
  media: MediaPreviewItem;
}

const ASSET_TYPE_LABELS: Record<string, string> = {
  poster_image: 'Poster image',
  poster_pdf: 'Poster PDF',
  snapshot_image: 'Snapshot image',
};

export function ImageMediaPreview({
  media,
}: ImageMediaPreviewProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  if (!media.url) {
    return (
      <div role="status" className={MEDIA_PREVIEW_CLASSES.tile}>
        <p className={MEDIA_PREVIEW_CLASSES.stateMessage}>
          <ImageOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>Media file is missing.</span>
        </p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  if (!isValidMediaUrl(media.url)) {
    return (
      <div role="alert" className={MEDIA_PREVIEW_CLASSES.tile}>
        <p className={MEDIA_PREVIEW_CLASSES.stateMessage}>
          <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>Invalid media URL.</span>
        </p>
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
    <div className={MEDIA_PREVIEW_CLASSES.tile}>
      {media.assetType && (
        <p className={MEDIA_PREVIEW_CLASSES.assetLabel}>
          {ASSET_TYPE_LABELS[media.assetType] ?? media.assetType}
        </p>
      )}

      {isLoading && !hasError && (
        <p className={MEDIA_PREVIEW_CLASSES.stateMessage} role="status">
          <span>Loading image preview...</span>
        </p>
      )}

      {hasError ? (
        <div role="alert">
          <p className={MEDIA_PREVIEW_CLASSES.stateMessage}>
            <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <span>Image preview could not be loaded.</span>
          </p>
        </div>
      ) : (
        <div className={MEDIA_PREVIEW_CLASSES.frame}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={media.url}
            alt={savedAltText}
            // A cached image can finish decoding before React attaches `onLoad`, which would
            // otherwise leave a permanent "Loading image preview..." message above a fully
            // rendered image. The ref settles the state from the element's own `complete` flag.
            ref={(element) => {
              if (element?.complete) setIsLoading(false);
            }}
            onLoad={() => {
              setIsLoading(false);
            }}
            onError={() => {
              setIsLoading(false);
              setHasError(true);
            }}
            className="mx-auto block h-auto max-h-80 max-w-full object-contain"
          />
        </div>
      )}

      {savedAltText !== '' && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Text alternative</p>
          <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground-subtle">
            {savedAltText}
          </p>
        </div>
      )}

      {savedAltText === '' && media.assetType === 'snapshot_image' && (
        <p role="status" className={MEDIA_PREVIEW_CLASSES.blockingState}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>Snapshot alt text missing.</span>
        </p>
      )}

      <MediaFileInfo media={media} />
    </div>
  );
}
