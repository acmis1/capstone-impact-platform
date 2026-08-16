import React from 'react';

import { isAccessibleContentPresent } from '../../domain/accessibleContent';
import type { ProjectMediaPreviewItem } from './mediaPreviewTypes';

interface MediaAccessibilityReviewProps {
  media: ProjectMediaPreviewItem;
  fullText?: string | null;
}

function isImage(media: ProjectMediaPreviewItem): boolean {
  return media.mimeType.startsWith('image/');
}

function isPdf(media: ProjectMediaPreviewItem): boolean {
  return media.mimeType === 'application/pdf';
}

export function MediaAccessibilityReview({
  media,
  fullText,
}: MediaAccessibilityReviewProps) {
  const image = isImage(media);
  const pdf = isPdf(media);

  const hasAltText = isAccessibleContentPresent(media.altText);
  const hasFullText = isAccessibleContentPresent(fullText);

  const posterImage = media.role === 'poster';

  const requiresAltText = image;
  const requiresFullText = pdf || posterImage;

  const incomplete =
    (requiresAltText && !hasAltText) ||
    (requiresFullText && !hasFullText);

  const status = incomplete
    ? 'Accessibility information incomplete'
    : hasFullText
      ? 'Full text available'
      : 'Text alternative available';

  const headingId = `media-accessibility-${media.id}`;

  if (!image && !pdf) {
    return (
      <section aria-labelledby={headingId}>
        <h4 id={headingId}>Accessibility review — {media.fileName}</h4>
        <p role="status">Accessibility review unavailable for this media type.</p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      style={{
        marginTop: '0.75rem',
        marginBottom: '1.5rem',
        padding: '1rem',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '8px',
      }}
    >
      <h4 id={headingId} style={{ marginTop: 0 }}>
        Accessibility review — {media.fileName}
      </h4>

      <p role="status">
        <strong>Status:</strong> {status}
      </p>

      {image && (
        <div>
          <strong>Alternative text</strong>

          {hasAltText ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>{media.altText}</p>
          ) : (
            <p>Alternative text is not available for this image.</p>
          )}
        </div>
      )}

      {requiresFullText && (
        <div>
          <strong>Full text equivalent</strong>

          {hasFullText ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>{fullText}</p>
          ) : (
            <p>No full-text equivalent is available for this media asset.</p>
          )}
        </div>
      )}
    </section>
  );
}