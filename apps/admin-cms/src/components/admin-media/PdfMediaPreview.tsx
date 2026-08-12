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
  const [hasLoaded, setHasLoaded] = useState(false);
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
      <a href={media.url} target="_blank" rel="noopener noreferrer">
        Open PDF in a new tab
      </a>
      {hasError ? (
        <div role="alert">
          <p>Inline PDF preview is unavailable. The file can still be opened in a new tab.</p>
        </div>
      ) : (
        <>
          {!hasLoaded && <p role="status">Loading PDF preview...</p>}
          <iframe
            src={media.url}
            title={`PDF preview of ${media.fileName}`}
            onLoad={() => setHasLoaded(true)}
            onError={() => { setHasLoaded(false); setHasError(true); }}
            style={{ display: 'block', width: '100%', minHeight: '32rem', border: 0 }}
          />
        </>
      )}

      <MediaFileInfo media={media} />
    </div>
  );
}
