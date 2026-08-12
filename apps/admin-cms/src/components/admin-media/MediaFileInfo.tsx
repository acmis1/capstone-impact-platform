import { formatFileSize } from './mediaPreviewUtils';
import type { MediaPreviewItem } from './mediaPreviewTypes';

interface MediaFileInfoProps {
  media: MediaPreviewItem;
}

export function MediaFileInfo({ media }: MediaFileInfoProps) {
  return (
    <div>
      <p>
        <strong>File name:</strong> {media.fileName}
      </p>
      <p>
        <strong>MIME type:</strong> {media.mimeType}
      </p>
      <p>
        <strong>File size:</strong> {formatFileSize(media.fileSize)}
      </p>
    </div>
  );
}
