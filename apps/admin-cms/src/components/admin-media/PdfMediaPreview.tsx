'use client';

import { useState } from 'react';
import { ExternalLink, FileWarning } from 'lucide-react';

import { MediaFileInfo } from './MediaFileInfo';
import type { MediaPreviewItem } from './mediaPreviewTypes';
import { isValidMediaUrl } from './mediaPreviewUtils';
import { MEDIA_PREVIEW_CLASSES } from './mediaPreviewStyles';

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
      <div role="status" className={MEDIA_PREVIEW_CLASSES.tile}>
        <p className={MEDIA_PREVIEW_CLASSES.stateMessage}>
          <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>PDF file is missing.</span>
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
          <span>Invalid PDF URL.</span>
        </p>
        <MediaFileInfo media={media} />
      </div>
    );
  }

  return (
    <div className={MEDIA_PREVIEW_CLASSES.tile}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={MEDIA_PREVIEW_CLASSES.assetLabel}>Poster PDF</p>
        <a
          href={media.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[32px] items-center gap-1.5 text-sm font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Open PDF in a new tab
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
        </a>
      </div>

      {hasError ? (
        <div role="alert">
          <p className={MEDIA_PREVIEW_CLASSES.stateMessage}>
            <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>Inline PDF preview is unavailable. The file can still be opened in a new tab.</span>
          </p>
        </div>
      ) : (
        <>
          {!hasLoaded && (
            <p role="status" className={MEDIA_PREVIEW_CLASSES.stateMessage}>
              <span>Loading PDF preview...</span>
            </p>
          )}
          <div className={MEDIA_PREVIEW_CLASSES.frame}>
            <iframe
              src={media.url}
              title={`PDF preview of ${media.fileName}`}
              onLoad={() => setHasLoaded(true)}
              onError={() => { setHasLoaded(false); setHasError(true); }}
              className="block min-h-80 w-full border-0"
            />
          </div>
        </>
      )}

      <MediaFileInfo media={media} />
    </div>
  );
}
