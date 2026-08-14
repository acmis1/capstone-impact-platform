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
  /**
   * The text alternative captured at issuance, immutable for the life of this preview version.
   *
   * A non-empty string for `snapshot_image` — preview generation fails closed rather than issuing a
   * preview of an undescribed image — and null for `poster_image` and `poster_pdf`. The poster's
   * text alternative is the snapshotted project-level `accessibilityText`, deliberately not
   * duplicated onto the media asset.
   */
  altText: string | null;
}

export interface ParticipantPreviewMediaViewRef {
  mediaAssetId: string;
  assetType: string;
  fileName: string;
  mimeType: string | null;
  /** Carried through from the immutable snapshot; never re-read from current media state. */
  altText: string | null;
  signedUrl: string | null;
}

/**
 * Result of confirming (or re-confirming) an exact participant preview version. Means only
 * "the participant confirmed this exact immutable preview" — never that the mutable project row
 * is confirmed, never a workflow status change, and never publication.
 */
export interface ParticipantPreviewConfirmationResult {
  confirmationId: string;
  confirmedAt: string;
  alreadyConfirmed: boolean;
}

/**
 * Confirmation status for an already-resolved participant preview, as read by either the
 * participant-facing route (post-resolution) or Admin/CMS staff view. Never exposes the token
 * hash or other internal-only identifiers beyond the confirmation timestamp.
 */
export interface ParticipantPreviewConfirmationStatus {
  confirmedAt: string;
}

/**
 * Result of requesting (or idempotently re-requesting) a correction against an exact participant
 * preview version. Means only "the participant requested changes to this exact immutable
 * preview" — never that project metadata was changed, never that the correction was resolved,
 * never a workflow status change, and never publication.
 */
export interface ParticipantPreviewCorrectionRequestResult {
  correctionRequestId: string;
  requestedAt: string;
  comment: string;
  alreadyRequested: boolean;
}

/**
 * Correction-request status for an already-resolved participant preview, as read by either the
 * participant-facing route (post-resolution) or Admin/CMS staff view. Never exposes the token
 * hash or other internal-only identifiers beyond the request timestamp and comment.
 */
export interface ParticipantPreviewCorrectionRequestStatus {
  requestedAt: string;
  comment: string;
}

export interface ParticipantPreviewCorrectionResolutionStatus {
  status: 'open' | 'in_progress' | 'resolved';
  correctionRequestId: string;
  participantPreviewId: string;
  comment: string;
  requestedAt: string;
  resolutionStartedAt?: string | null;
  resolutionStartedBy?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  replacementPreviewId?: string | null;
}

export interface StartCorrectionResolutionResult {
  correctionRequestId: string;
  resolutionStartedAt: string;
  auditRecordId?: string;
  alreadyInProgress?: boolean;
}

/**
 * The participant-response state for one exact participant preview version is always exactly one
 * of these three — never both confirmed and correction_requested (enforced transactionally at the
 * Migration 0015 RPC layer, see request_participant_preview_correction and the extended
 * confirm_participant_preview). Server rendering must resolve to this type and fail closed
 * (throw) rather than construct it from contradictory underlying rows.
 */
export type ParticipantPreviewResponseState =
  | { type: 'unresponded' }
  | ({ type: 'confirmed' } & ParticipantPreviewConfirmationStatus)
  | ({ type: 'correction_requested' } & ParticipantPreviewCorrectionRequestStatus);
