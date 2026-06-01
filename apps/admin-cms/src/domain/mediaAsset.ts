export interface MediaAsset {
  id: string; // uuid
  projectId: number; // Foreign key referencing Project deterministic ID
  assetType:
    | 'poster_image'
    | 'poster_pdf'
    | 'snapshot'
    | 'demo_video'
    | 'audio_track'
    | '3d_model'
    | 'accessibility_text'
    | string;
  fileName: string; // Sanitized file name
  storageBucket: string; // Indicates project-drafts-private vs. project-public-assets
  storagePath: string; // Full relative key inside bucket
  publicUrl?: string; // Reachable HTTPS endpoint URL (active only after CMS Approval)
  fileSize: number; // Size in bytes
  createdAt: string;
}
