'use client';

import { useState } from 'react';

import { MediaFileInfo } from './MediaFileInfo';
import type { MediaPreviewItem } from './mediaPreviewTypes';
import { isValidMediaUrl } from './mediaPreviewUtils';

interface PdfMediaPreviewProps {
  media: MediaPreviewItem;
}

export function PdfMediaPreview({
  media,
}: PdfMediaPreviewProps) {
  const [hasError, setHasError] = useState(false);

  if (!media.url) {
    return (
      <div role="status">
        <p>PDF file is missing.</p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  if (!isValidMediaUrl(media.url)) {
    return (
      <div role="alert">
        <p>Invalid PDF URL.</p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  return (
    <div>
      {hasError ? (
        <div role="alert">
          <p>PDF preview is unavailable.</p>
          <a
            href={media.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open PDF in a new tab
          </a>
        </div>
      ) : (
        <iframe
          src={media.url}
          title={`PDF preview of ${media.fileName}`}
          onError={() => setHasError(true)}
        />
      )}

      <MediaFileInfo media={media} />
    </div>
  );
}