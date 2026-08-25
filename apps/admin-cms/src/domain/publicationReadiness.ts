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

/**
 * Deployment reconciliation evaluates a project that is already lifecycle `published`, so it can
 * report two outcomes a pre-publication gate never needs: accessible-content problems found on the
 * live published row, and a public media mapping that no longer matches its authoritative source.
 *
 * This is an additive sibling. PublicationReadinessCode is deliberately left untouched so normal
 * publication readiness keeps exactly the semantics it has today.
 */
export type ReconciliationReadinessCode =
  | PublicationReadinessCode
  | 'ACCESSIBILITY_CONTENT_REQUIRED'
  | 'PUBLISHED_MEDIA_MAPPING_INVALID';

export interface ReconciliationReadinessResult {
  ready: boolean;
  resultCode: ReconciliationReadinessCode;
  blockers: string[];
  confirmedPreviewId?: string;
  confirmedAt?: string;
}
