export interface MediaAsset {
  id: string; // uuid
  projectId: string; // references projects.id (UUID)
  projectPublicId: string; // references projects.public_id
  assetType:
    | 'poster_image'
    | 'poster_pdf'
    | 'snapshot_image'
    | 'video_link'
    | 'other'
    | string;
  fileName: string;
  storageBucket: string;
  storagePath: string;
  publicUrl?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  isPublicApproved: boolean;
  /**
   * Staff-authored text alternative for this asset, or null when it has none.
   *
   * Required for `snapshot_image` before the project may progress through review, approval,
   * participant preview or publication. Null is correct for `poster_pdf`, and for `poster_image`
   * whose text alternative remains the project-level `accessibilityText` rather than being
   * duplicated here. A filename is never a substitute for this value.
   */
  altTextPublic: string | null;
  createdAt: string;
}

export type MediaAssetType = MediaAsset['assetType'];
