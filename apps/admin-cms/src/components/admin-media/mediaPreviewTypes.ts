export type MediaKind = 'image' | 'pdf' | 'unsupported';

export interface MediaPreviewItem {
  url?: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  altText?: string;
}