export type MediaKind = 'image' | 'pdf' | 'video' | 'unsupported';

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

  /**
   * The authoritative saved text alternative, when one exists. Never a filename-derived
   * substitute — absence means no alt text is stored, and surfaces are expected to say so.
   */
  altText?: string;

  role?: MediaRole;
  position?: number;

  /** Known for project media; absent for standalone preview samples. */
  assetType?: string;
}

export interface ProjectMediaPreviewItem extends MediaPreviewItem {
  id: string;
  assetType: string;
  previewSource: MediaPreviewSource;
}