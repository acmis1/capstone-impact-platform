import { ImageMediaPreview } from './ImageMediaPreview';
import { MediaFileInfo } from './MediaFileInfo';
import { PdfMediaPreview } from './PdfMediaPreview';
import type { MediaPreviewItem } from './mediaPreviewTypes';
import { classifyMediaType } from './mediaPreviewUtils';
import { VideoMediaPreview } from './VideoMediaPreview';

interface MediaPreviewProps {
  media: MediaPreviewItem;
}

export function MediaPreview({
  media,
}: MediaPreviewProps) {
  const mediaKind = classifyMediaType(media.mimeType);

  if (mediaKind === 'image') {
    return <ImageMediaPreview media={media} />;
  }

  if (mediaKind === 'pdf') {
    return <PdfMediaPreview media={media} />;
  }

  if (mediaKind === 'video') {
    return <VideoMediaPreview media={media} />;
  }

  return (
    <div role="alert">
      <p>Unsupported media type.</p>
      <MediaFileInfo media={media} />
    </div>
  );
}