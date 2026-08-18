import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { isAccessibleContentPresent } from '../../domain/accessibleContent';
import type { ProjectMediaPreviewItem } from './mediaPreviewTypes';
import { isValidMediaUrl } from './mediaPreviewUtils';

interface MediaAccessibilityReviewProps {
  media: ProjectMediaPreviewItem;
  fullText?: string | null;
}

const ASSET_TYPE_LABELS: Record<string, string> = {
  poster_image: 'Poster image',
  poster_pdf: 'Poster PDF',
  snapshot_image: 'Snapshot image',
};

export function MediaAccessibilityReview({
  media,
  fullText,
}: MediaAccessibilityReviewProps) {
  const isImage = media.mimeType.startsWith('image/');
  const isPdf = media.mimeType === 'application/pdf';

  if (!isImage && !isPdf) return null;

  const requiresAltText = isImage;
  const requiresFullText = media.assetType === 'poster_image' || media.assetType === 'poster_pdf';
  const hasAltText = isAccessibleContentPresent(media.altText);
  const hasFullText = isAccessibleContentPresent(fullText);
  const incomplete = (requiresAltText && !hasAltText) || (requiresFullText && !hasFullText);
  const previewDisplaysAltText = isImage && isValidMediaUrl(media.url);
  const headingId = `media-accessibility-${media.id}`;
  const assetLabel = ASSET_TYPE_LABELS[media.assetType] ?? media.assetType;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-inset p-3"
    >
      <h4 id={headingId} className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle">
        Accessibility review — {assetLabel}: <span className="normal-case tracking-normal">{media.fileName}</span>
      </h4>

      {incomplete && (
        <p className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-2.5 text-sm font-medium leading-relaxed text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <span>Accessibility information incomplete</span>
        </p>
      )}

      <div className="mt-2 flex flex-col gap-3 text-sm leading-relaxed text-foreground-subtle">
        {requiresAltText && (
          <div>
            {hasAltText ? (
              <p className="flex items-start gap-2 font-medium text-foreground">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <span>Text alternative available</span>
              </p>
            ) : (
              <p>Alternative text is not available for this image.</p>
            )}

            {hasAltText && !previewDisplaysAltText && (
              <p className="mt-1 whitespace-pre-wrap break-words">{media.altText}</p>
            )}
          </div>
        )}

        {requiresFullText && (
          <div>
            {hasFullText ? (
              <>
                <p className="flex items-start gap-2 font-medium text-foreground">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  <span>Full text available</span>
                </p>
                <details className="mt-1">
                  <summary className="cursor-pointer font-medium text-foreground underline decoration-border-strong underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                    View full-text equivalent
                  </summary>
                  <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border pl-3">
                    {fullText}
                  </p>
                </details>
              </>
            ) : (
              <p>A full-text equivalent is not available for this poster.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
