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
  createdAt: string;
}

export type MediaAssetType = MediaAsset['assetType'];
