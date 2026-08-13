export type MediaKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'unsupported';

export type MediaRole =
  | 'poster'
  | 'poster-pdf'
  | 'image'
  | 'snapshot'
  | 'video'
  | '3d-image';

export type MediaPreviewSource =
  | 'public'
  | 'private-signed'
  | 'unavailable';

export interface MediaPreviewItem {
  url?: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  altText?: string;

  role?: MediaRole;
  position?: number;
}

export interface ProjectMediaPreviewItem
  extends MediaPreviewItem {
  id: string;
  assetType: string;
  previewSource: MediaPreviewSource;
}