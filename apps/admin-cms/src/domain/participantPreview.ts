export interface ParticipantPreviewExternalLink {
  label?: string;
  url: string;
}

/**
 * Immutable, server-derived participant-facing snapshot captured at preview issuance.
 * Mirrors the public-safe field contract in domain/project.ts; internal-only fields
 * (internalStaffNotes, privateReviewComments, validation state, workflow status, etc.)
 * are intentionally never included.
 */
export interface ParticipantPreviewSnapshot {
  title: string;
  summary: string | null;
  background: string | null;
  solution: string | null;
  year: number;
  program: string | null;
  studyProgram: string | null;
  discipline: string | null;
  disciplines: string[];
  industry: string | null;
  industryPartner: string | null;
  academicSupervisor: string | null;
  groupName: string | null;
  teamMembers: string[];
  posterText: string | null;
  accessibilityText: string | null;
  citations: string[];
  externalLinks: ParticipantPreviewExternalLink[];
  industryCategories: string[];
}

/**
 * Reference to a private draft media object captured at issuance time. Only bucket/path/type
 * metadata is persisted; short-lived signed URLs are generated on demand at view time.
 */
export interface ParticipantPreviewMediaRef {
  mediaAssetId: string;
  assetType: string;
  fileName: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string | null;
}

export interface ParticipantPreviewMediaViewRef {
  mediaAssetId: string;
  assetType: string;
  fileName: string;
  mimeType: string | null;
  signedUrl: string | null;
}
