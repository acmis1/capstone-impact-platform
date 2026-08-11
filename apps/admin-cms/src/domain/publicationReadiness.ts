export type PublicationReadinessCode =
  | 'READY'
  | 'PROJECT_NOT_FOUND'
  | 'READINESS_PERMISSION_DENIED'
  | 'INVALID_PROJECT_STATE'
  | 'INVALID_SELECTION'
  | 'INVALID_PRIVATE_BUCKET'
  | 'NO_ACTIVE_PREVIEW'
  | 'PREVIEW_NOT_CONFIRMED'
  | 'CORRECTION_UNRESOLVED'
  | 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION'
  | 'PROJECT_SNAPSHOT_STALE'
  | 'MEDIA_SNAPSHOT_STALE'
  | 'READINESS_UNAVAILABLE';

export interface PublicationReadinessResult {
  ready: boolean;
  resultCode: PublicationReadinessCode;
  blockers: string[];
  confirmedPreviewId?: string;
  confirmedAt?: string;
}
