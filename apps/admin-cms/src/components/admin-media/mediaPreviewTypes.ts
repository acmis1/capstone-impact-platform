export type MediaKind = 'image' | 'pdf' | 'unsupported';

export interface MediaPreviewItem {
  url?: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  altText?: string;
}

export interface ProjectMediaPreviewItem extends MediaPreviewItem {
  id: string;
  assetType: string;
  previewSource: 'private-signed' | 'public' | 'unavailable';
}
