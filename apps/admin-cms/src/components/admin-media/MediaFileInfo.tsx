import { formatFileSize } from './mediaPreviewUtils';
import type { MediaPreviewItem } from './mediaPreviewTypes';

interface MediaFileInfoProps {
  media: MediaPreviewItem;
}

/**
 * Technical file facts for a media asset. Values stay direct text children of their own
 * element so long file names wrap instead of stretching the preview tile.
 */
export function MediaFileInfo({ media }: MediaFileInfoProps) {
  return (
    <dl className="mt-3 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <dt className="font-medium text-foreground-subtle">File name:</dt>
        <dd className="min-w-0 break-all">{media.fileName}</dd>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <dt className="font-medium text-foreground-subtle">MIME type:</dt>
        <dd className="min-w-0 break-all">{media.mimeType}</dd>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <dt className="font-medium text-foreground-subtle">File size:</dt>
        <dd>{formatFileSize(media.fileSize)}</dd>
      </div>
    </dl>
  );
}
