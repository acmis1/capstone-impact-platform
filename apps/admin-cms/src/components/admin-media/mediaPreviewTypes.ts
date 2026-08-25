export type MediaKind = 'image' | 'pdf' | 'unsupported';

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
  /** Known for project media; absent for standalone preview samples. */
  assetType?: string;
}

export interface ProjectMediaPreviewItem extends MediaPreviewItem {
  id: string;
  assetType: string;

  /**
   * Deterministic order for snapshot_image.
   * Null for non-gallery media such as poster image/PDF.
   */
  galleryPosition: number | null;

  previewSource: 'private-signed' | 'public' | 'unavailable';
}