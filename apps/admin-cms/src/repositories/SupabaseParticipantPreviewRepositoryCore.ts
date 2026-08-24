import { SupabaseClient } from '@supabase/supabase-js';
import { ParticipantPreviewExecutionError } from './ParticipantPreviewRepository';
import {
  ParticipantPreviewConfirmationResult,
  ParticipantPreviewConfirmationStatus,
  ParticipantPreviewCorrectionRequestResult,
  ParticipantPreviewCorrectionRequestStatus,
  ParticipantPreviewMediaRef,
  ParticipantPreviewResponseState,
  ParticipantPreviewSnapshot,
} from '../domain/participantPreview';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import { normalizeParticipantPreviewTimestamp } from './participantPreviewTimestamp';

export const DEFAULT_PREVIEW_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface GeneratePreviewResult {
  previewId: string;
  publicId: string;
  createdAt: string;
  expiresAt: string;
}

export interface RevokePreviewResult {
  previewId: string;
  publicId: string;
  revokedAt: string;
}

export interface ActivePreviewSummary {
  previewId: string;
  createdAt: string;
  expiresAt: string;
  createdBy: string | null;
}

export interface ResolvedParticipantPreview {
  previewId: string;
  snapshot: ParticipantPreviewSnapshot;
  mediaSnapshot: ParticipantPreviewMediaRef[];
  expiresAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates the immutable media snapshot stored on a participant preview, returning null if any
 * element is malformed so the caller can fail closed.
 *
 * `altText` must be structurally present on every element. A `snapshot_image` must carry a usable
 * string, since that value becomes the participant-facing alt attribute and there is no acceptable
 * fallback for it. Any other asset type must carry null: the poster's text alternative is the
 * project-level accessibilityText in the project snapshot, and a value here would mean the stored
 * evidence disagrees with the contract that produced it.
 */
function parseMediaSnapshot(raw: unknown[]): ParticipantPreviewMediaRef[] | null {
  const parsed: ParticipantPreviewMediaRef[] = [];
  let previousGalleryPosition = 0;

  for (const element of raw) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      return null;
    }

    const item = element as Record<string, unknown>;

    if (
      !isNonEmptyString(item.mediaAssetId) ||
      !isNonEmptyString(item.assetType) ||
      !isNonEmptyString(item.fileName) ||
      !isNonEmptyString(item.storageBucket) ||
      !isNonEmptyString(item.storagePath)
    ) {
      return null;
    }

    const mimeType =
      item.mimeType === null || item.mimeType === undefined
        ? null
        : item.mimeType;

    if (mimeType !== null && typeof mimeType !== 'string') {
      return null;
    }

    if (!('galleryPosition' in item)) {
      return null;
    }

    let galleryPosition: number | null;

    if (item.assetType === 'snapshot_image') {
      if (
        typeof item.galleryPosition !== 'number' ||
        !Number.isInteger(item.galleryPosition) ||
        item.galleryPosition < 1 ||
        item.galleryPosition > 10
      ) {
        return null;
      }

      /*
       * The immutable snapshot itself must already be in authoritative
       * gallery order. Do not silently repair malformed evidence here.
       */
      if (item.galleryPosition <= previousGalleryPosition) {
        return null;
      }

      galleryPosition = item.galleryPosition;
      previousGalleryPosition = item.galleryPosition;
    } else {
      /*
       * galleryPosition belongs only to snapshot_image.
       * Keeping explicit null makes the immutable media shape uniform.
       */
      if (item.galleryPosition !== null) {
        return null;
      }

      galleryPosition = null;
    }

    if (!('altText' in item)) {
      return null;
    }

    let altText: string | null;

    if (item.assetType === 'snapshot_image') {
      if (typeof item.altText !== 'string') {
        return null;
      }

      const trimmed = item.altText.trim();

      if (
        trimmed === '' ||
        trimmed.length > ACCESSIBLE_CONTENT_LIMITS.snapshotAltText
      ) {
        return null;
      }

      altText = item.altText;
    } else {
      if (item.altText !== null) {
        return null;
      }

      altText = null;
    }

    parsed.push({
      mediaAssetId: item.mediaAssetId,
      assetType: item.assetType,
      galleryPosition,
      fileName: item.fileName,
      storageBucket: item.storageBucket,
      storagePath: item.storagePath,
      mimeType,
      altText,
    });
  }

  return parsed;
}

export class SupabaseParticipantPreviewRepositoryCore {
  constructor(protected supabase: SupabaseClient) {}

  /**
   * Atomically generates a new participant preview via the service-role-only
   * generate_participant_preview RPC. The raw token itself is generated and hashed by the
   * caller — this method only ever transmits the hash.
   */
  async generatePreview(params: {
    publicId: string;
    adminId: string;
    tokenHash: string;
    privateBucket: string;
    expiresInSeconds?: number;
    isCorrectionReissue?: boolean;
  }): Promise<GeneratePreviewResult> {
    const { publicId, adminId, tokenHash, privateBucket, expiresInSeconds, isCorrectionReissue } = params;

    if (
      !isNonEmptyString(publicId) ||
      !isNonEmptyString(adminId) ||
      !isNonEmptyString(tokenHash) ||
      !isNonEmptyString(privateBucket)
    ) {
      throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    const { data, error } = await this.supabase.rpc('generate_participant_preview', {
      p_public_id: publicId,
      p_admin_id: adminId,
      p_token_hash: tokenHash,
      p_expires_in_seconds: expiresInSeconds ?? DEFAULT_PREVIEW_EXPIRES_IN_SECONDS,
      p_private_bucket: privateBucket,
      p_is_correction_reissue: isCorrectionReissue ?? false,
    });

    if (error) {
      if ((error.message || '').includes('PUBLICATION_IN_PROGRESS')) {
        throw new ParticipantPreviewExecutionError('PUBLICATION_IN_PROGRESS');
      }
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (!data || typeof data !== 'object') {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    const res = data as Record<string, unknown>;

    switch (res.resultCode) {
      case 'SUCCESS':
        break;
      case 'PROJECT_NOT_FOUND':
        throw new ParticipantPreviewExecutionError('PROJECT_NOT_FOUND');
      case 'INVALID_PROJECT_STATE':
        throw new ParticipantPreviewExecutionError('INVALID_PROJECT_STATE');
      case 'PREVIEW_PERMISSION_DENIED':
        throw new ParticipantPreviewExecutionError('PERMISSION_DENIED');
      case 'ACTIVE_PREVIEW_EXISTS':
        throw new ParticipantPreviewExecutionError('ACTIVE_PREVIEW_EXISTS');
      case 'CORRECTION_RESOLUTION_REQUIRED':
        throw new ParticipantPreviewExecutionError('CORRECTION_RESOLUTION_REQUIRED');
      case 'NO_CORRECTION_IN_PROGRESS':
        throw new ParticipantPreviewExecutionError('NO_CORRECTION_IN_PROGRESS');
      case 'AMBIGUOUS_CORRECTION_REQUEST':
        throw new ParticipantPreviewExecutionError('AMBIGUOUS_CORRECTION_REQUEST');
      case 'MEDIA_ACCESSIBILITY_REQUIRED':
        throw new ParticipantPreviewExecutionError('MEDIA_ACCESSIBILITY_REQUIRED');
      default:
        throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    const createdAt = normalizeParticipantPreviewTimestamp(res.createdAt);
    const expiresAt = normalizeParticipantPreviewTimestamp(res.expiresAt);
    if (
      !isNonEmptyString(res.previewId) ||
      !isNonEmptyString(res.publicId) ||
      !createdAt ||
      !expiresAt
    ) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      previewId: res.previewId,
      publicId: res.publicId,
      createdAt,
      expiresAt,
    };
  }

  /**
   * Atomically revokes the active preview for a project via the service-role-only
   * revoke_participant_preview RPC. The preview row itself remains for audit/history.
   */
  async revokePreview(params: { publicId: string; adminId: string }): Promise<RevokePreviewResult> {
    const { publicId, adminId } = params;

    if (!isNonEmptyString(publicId) || !isNonEmptyString(adminId)) {
      throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    const { data, error } = await this.supabase.rpc('revoke_participant_preview', {
      p_public_id: publicId,
      p_admin_id: adminId,
    });

    if (error) {
      if ((error.message || '').includes('PUBLICATION_IN_PROGRESS')) {
        throw new ParticipantPreviewExecutionError('PUBLICATION_IN_PROGRESS');
      }
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (!data || typeof data !== 'object') {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    const res = data as Record<string, unknown>;

    switch (res.resultCode) {
      case 'SUCCESS':
        break;
      case 'PROJECT_NOT_FOUND':
        throw new ParticipantPreviewExecutionError('PROJECT_NOT_FOUND');
      case 'PREVIEW_PERMISSION_DENIED':
        throw new ParticipantPreviewExecutionError('PERMISSION_DENIED');
      case 'NO_ACTIVE_PREVIEW':
        throw new ParticipantPreviewExecutionError('NO_ACTIVE_PREVIEW');
      default:
        throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    const revokedAt = normalizeParticipantPreviewTimestamp(res.revokedAt);
    if (!isNonEmptyString(res.previewId) || !isNonEmptyString(res.publicId) || !revokedAt) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      previewId: res.previewId,
      publicId: res.publicId,
      revokedAt,
    };
  }

  /**
   * Direct read of the active preview row for a project (service-role client bypasses RLS,
   * same convention as the project detail page's direct approval_records read). Used only to
   * render admin UI state — never exposes the token hash.
   */
  async getActivePreview(projectDbId: string): Promise<ActivePreviewSummary | null> {
    if (!isNonEmptyString(projectDbId)) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('participant_previews')
      .select('id, created_at, expires_at, created_by')
      .eq('project_id', projectDbId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (!data) {
      return null;
    }

    const createdAt = normalizeParticipantPreviewTimestamp(data.created_at);
    const expiresAt = normalizeParticipantPreviewTimestamp(data.expires_at);
    if (!createdAt || !expiresAt) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      previewId: data.id,
      createdAt,
      expiresAt,
      createdBy: data.created_by ?? null,
    };
  }

  /**
   * Resolves a participant-supplied token hash via the service-role-only
   * resolve_participant_preview RPC. Deliberately returns null on every failure mode (unknown,
   * malformed, expired, revoked, or unexpected error) so the caller can render one generic
   * unavailable response without ever distinguishing the reason.
   */
  async resolveByTokenHash(tokenHash: string): Promise<ResolvedParticipantPreview | null> {
    if (!isNonEmptyString(tokenHash)) {
      return null;
    }

    const { data, error } = await this.supabase.rpc('resolve_participant_preview', {
      p_token_hash: tokenHash,
    });

    if (error || !data || typeof data !== 'object') {
      return null;
    }

    const res = data as Record<string, unknown>;
    if (res.resultCode !== 'SUCCESS') {
      return null;
    }

    const expiresAt = normalizeParticipantPreviewTimestamp(res.expiresAt);
    if (
      !isNonEmptyString(res.previewId) ||
      typeof res.snapshot !== 'object' || res.snapshot === null ||
      !Array.isArray(res.mediaSnapshot) ||
      !expiresAt
    ) {
      return null;
    }

    // The stored media snapshot is participant-facing evidence, so it is validated element by
    // element rather than cast. A snapshot image whose alt text is missing or unusable makes the
    // whole preview unresolvable — the participant sees the generic unavailable page and staff
    // reissue — because the alternative is rendering an image the participant cannot perceive.
    const mediaSnapshot = parseMediaSnapshot(res.mediaSnapshot);
    if (!mediaSnapshot) {
      return null;
    }

    return {
      previewId: res.previewId,
      snapshot: res.snapshot as ParticipantPreviewSnapshot,
      mediaSnapshot,
      expiresAt,
    };
  }

  /**
   * Confirms (or idempotently re-confirms) the exact participant preview version identified by
   * a token hash, via the service-role-only confirm_participant_preview RPC. Deliberately
   * returns null on every failure mode (unknown, malformed, expired, revoked, or unexpected
   * error) — identical in shape to resolveByTokenHash — so the caller renders one generic
   * unavailable outcome without ever distinguishing the reason.
   */
  async confirmPreview(tokenHash: string): Promise<ParticipantPreviewConfirmationResult | null> {
    if (!isNonEmptyString(tokenHash)) {
      return null;
    }

    const { data, error } = await this.supabase.rpc('confirm_participant_preview', {
      p_token_hash: tokenHash,
    });

    if (error || !data || typeof data !== 'object') {
      return null;
    }

    const res = data as Record<string, unknown>;
    if (res.resultCode !== 'SUCCESS') {
      return null;
    }

    const confirmedAt = normalizeParticipantPreviewTimestamp(res.confirmedAt);
    if (
      !isNonEmptyString(res.confirmationId) ||
      !confirmedAt ||
      typeof res.alreadyConfirmed !== 'boolean'
    ) {
      return null;
    }

    return {
      confirmationId: res.confirmationId,
      confirmedAt,
      alreadyConfirmed: res.alreadyConfirmed,
    };
  }

  /**
   * Direct read of a confirmation row for an already-resolved participant preview id (service-
   * role client bypasses RLS, same convention as getActivePreview). Used to render both the
   * participant-facing confirmed/unconfirmed state after GET resolution and the Admin/CMS
   * confirmation status — never exposes the token hash or other internal identifiers.
   *
   * Fails closed on a genuine query failure rather than returning null: null is reserved for the
   * one legitimate "no confirmation row exists yet" state, so callers must never be able to
   * mistake a backend failure for "not yet confirmed."
   */
  async getConfirmationStatus(participantPreviewId: string): Promise<ParticipantPreviewConfirmationStatus | null> {
    if (!isNonEmptyString(participantPreviewId)) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('participant_preview_confirmations')
      .select('confirmed_at')
      .eq('participant_preview_id', participantPreviewId)
      .maybeSingle();

    if (error) {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (!data) {
      return null;
    }

    const confirmedAt = normalizeParticipantPreviewTimestamp(data.confirmed_at);
    if (!confirmedAt) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return { confirmedAt };
  }

  /**
   * Requests (or idempotently re-requests) a correction against the exact participant preview
   * version identified by a token hash, via the service-role-only
   * request_participant_preview_correction RPC. Deliberately returns null for every non-SUCCESS
   * outcome (unknown/malformed/expired/revoked token, invalid comment, an existing confirmation
   * already recorded for this preview, or an unexpected error) — identical in shape to
   * confirmPreview — so the caller renders one generic outcome without ever distinguishing the
   * reason. The comment is expected to already be trimmed/bounded by the caller (see
   * validateCorrectionComment); the RPC independently re-validates at the database boundary.
   */
  async requestCorrection(tokenHash: string, comment: string): Promise<ParticipantPreviewCorrectionRequestResult | null> {
    if (!isNonEmptyString(tokenHash) || !isNonEmptyString(comment)) {
      return null;
    }

    const { data, error } = await this.supabase.rpc('request_participant_preview_correction', {
      p_token_hash: tokenHash,
      p_comment: comment,
    });

    if (error || !data || typeof data !== 'object') {
      return null;
    }

    const res = data as Record<string, unknown>;
    if (res.resultCode !== 'SUCCESS') {
      return null;
    }

    const requestedAt = normalizeParticipantPreviewTimestamp(res.requestedAt);
    if (
      !isNonEmptyString(res.correctionRequestId) ||
      !requestedAt ||
      !isNonEmptyString(res.comment) ||
      typeof res.alreadyRequested !== 'boolean'
    ) {
      return null;
    }

    return {
      correctionRequestId: res.correctionRequestId,
      requestedAt,
      comment: res.comment,
      alreadyRequested: res.alreadyRequested,
    };
  }

  /**
   * Direct read of a correction-request row for an already-resolved participant preview id
   * (service-role client bypasses RLS, same convention as getConfirmationStatus). Fails closed on
   * a genuine query failure rather than returning null: null is reserved for the one legitimate
   * "no correction request exists yet" state.
   */
  async getCorrectionRequestStatus(participantPreviewId: string): Promise<ParticipantPreviewCorrectionRequestStatus | null> {
    if (!isNonEmptyString(participantPreviewId)) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('participant_preview_correction_requests')
      .select('requested_at, correction_comment')
      .eq('participant_preview_id', participantPreviewId)
      .maybeSingle();

    if (error) {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (!data) {
      return null;
    }

    const requestedAt = normalizeParticipantPreviewTimestamp(data.requested_at);
    if (!requestedAt || typeof data.correction_comment !== 'string') {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return { requestedAt, comment: data.correction_comment };
  }

  /**
   * Resolves the authoritative participant-response state for an already-resolved participant
   * preview id: exactly one of unresponded, confirmed, or correction_requested. Fails closed
   * (throws RESPONSE_INVALID) if the underlying rows are ever contradictory (both a confirmation
   * and a correction request exist for the same preview) rather than silently picking one —
   * mirroring how getConfirmationStatus/getCorrectionRequestStatus already fail closed on a
   * genuine query error instead of returning a falsely-unresponded state.
   */
  async getResponseState(participantPreviewId: string): Promise<ParticipantPreviewResponseState> {
    const [confirmation, correctionRequest] = await Promise.all([
      this.getConfirmationStatus(participantPreviewId),
      this.getCorrectionRequestStatus(participantPreviewId),
    ]);

    if (confirmation && correctionRequest) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    if (confirmation) {
      return { type: 'confirmed', confirmedAt: confirmation.confirmedAt };
    }

    if (correctionRequest) {
      return { type: 'correction_requested', requestedAt: correctionRequest.requestedAt, comment: correctionRequest.comment };
    }

    return { type: 'unresponded' };
  }

  /**
   * Atomically starts administrative resolution for an open participant correction request via
   * start_participant_preview_correction_resolution.
   */
  async startCorrectionResolution(params: {
    publicId: string;
    adminId: string;
  }): Promise<{ correctionRequestId: string; resolutionStartedAt: string; auditRecordId?: string; alreadyInProgress?: boolean }> {
    const { publicId, adminId } = params;

    if (!isNonEmptyString(publicId) || !isNonEmptyString(adminId)) {
      throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    const { data, error } = await this.supabase.rpc('start_participant_preview_correction_resolution', {
      p_public_id: publicId,
      p_admin_id: adminId,
    });

    if (error) {
      if ((error.message || '').includes('PUBLICATION_IN_PROGRESS')) {
        throw new ParticipantPreviewExecutionError('PUBLICATION_IN_PROGRESS');
      }
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (!data || typeof data !== 'object') {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    const res = data as Record<string, unknown>;

    switch (res.resultCode) {
      case 'SUCCESS':
        break;
      case 'ALREADY_IN_PROGRESS': {
        const existingResolutionStartedAt = normalizeParticipantPreviewTimestamp(res.resolutionStartedAt);
        if (!isNonEmptyString(res.correctionRequestId) || !existingResolutionStartedAt) {
          throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
        }
        return {
          correctionRequestId: res.correctionRequestId,
          resolutionStartedAt: existingResolutionStartedAt,
          alreadyInProgress: true,
        };
      }
      case 'PROJECT_NOT_FOUND':
        throw new ParticipantPreviewExecutionError('PROJECT_NOT_FOUND');
      case 'INVALID_PROJECT_STATE':
        throw new ParticipantPreviewExecutionError('INVALID_PROJECT_STATE');
      case 'PERMISSION_DENIED':
        throw new ParticipantPreviewExecutionError('PERMISSION_DENIED');
      case 'NO_OPEN_CORRECTION':
        throw new ParticipantPreviewExecutionError('NO_OPEN_CORRECTION');
      case 'AMBIGUOUS_CORRECTION_REQUEST':
        throw new ParticipantPreviewExecutionError('AMBIGUOUS_CORRECTION_REQUEST');
      case 'CONFLICTING_ACTIVE_PREVIEW':
        throw new ParticipantPreviewExecutionError('CONFLICTING_ACTIVE_PREVIEW');
      default:
        throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    const resolutionStartedAt = normalizeParticipantPreviewTimestamp(res.resolutionStartedAt);
    if (!isNonEmptyString(res.correctionRequestId) || !resolutionStartedAt) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      correctionRequestId: res.correctionRequestId,
      resolutionStartedAt,
      auditRecordId: isNonEmptyString(res.auditRecordId) ? res.auditRecordId : undefined,
    };
  }

  /**
   * Reads the latest participant correction request resolution status for a project (by project DB ID).
   * Used to populate Admin UI state even when Preview A has been revoked or project status is changes_requested.
   *
   * Hardened:
   * 1. First checks for unresolved (open / in_progress) requests.
   * 2. If > 1 unresolved request exists for this project, fails closed (throws AMBIGUOUS_CORRECTION_REQUEST / RESPONSE_INVALID).
   * 3. If exactly 1 unresolved request exists, returns it.
   * 4. If 0 unresolved requests exist, returns the latest resolved request (if any).
   */
  async getCorrectionResolutionStatus(projectDbId: string): Promise<import('../domain/participantPreview').ParticipantPreviewCorrectionResolutionStatus | null> {
    if (!isNonEmptyString(projectDbId)) {
      return null;
    }

    // Check for unresolved requests first
    const { data: unresolvedData, error: unresolvedError } = await this.supabase
      .from('participant_preview_correction_requests')
      .select('id, status, participant_preview_id, correction_comment, requested_at, resolution_started_at, resolution_started_by, resolved_at, resolved_by, replacement_preview_id, participant_previews!participant_preview_correction_requ_participant_preview_id_fkey!inner(project_id)')
      .eq('participant_previews.project_id', projectDbId)
      .in('status', ['open', 'in_progress'])
      .order('requested_at', { ascending: false });

    if (unresolvedError) {
      throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
    }

    if (unresolvedData && unresolvedData.length > 1) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    let row = unresolvedData && unresolvedData.length === 1 ? unresolvedData[0] : null;

    if (!row) {
      // Fetch latest resolved request if no unresolved requests exist
      const { data: resolvedData, error: resolvedError } = await this.supabase
        .from('participant_preview_correction_requests')
        .select('id, status, participant_preview_id, correction_comment, requested_at, resolution_started_at, resolution_started_by, resolved_at, resolved_by, replacement_preview_id, participant_previews!participant_preview_correction_requ_participant_preview_id_fkey!inner(project_id)')
        .eq('participant_previews.project_id', projectDbId)
        .eq('status', 'resolved')
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (resolvedError) {
        throw new ParticipantPreviewExecutionError('INTERNAL_FAILURE');
      }

      row = resolvedData ?? null;
    }

    if (!row) {
      return null;
    }

    const status = row.status;
    if (status !== 'open' && status !== 'in_progress' && status !== 'resolved') {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    const requestedAt = normalizeParticipantPreviewTimestamp(row.requested_at);
    const resolutionStartedAt = row.resolution_started_at === null
      ? null
      : normalizeParticipantPreviewTimestamp(row.resolution_started_at);
    const resolvedAt = row.resolved_at === null
      ? null
      : normalizeParticipantPreviewTimestamp(row.resolved_at);

    if (
      !isNonEmptyString(row.id) ||
      !isNonEmptyString(row.participant_preview_id) ||
      typeof row.correction_comment !== 'string' ||
      !requestedAt ||
      (row.resolution_started_at !== null && !resolutionStartedAt) ||
      (row.resolved_at !== null && !resolvedAt)
    ) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    // Validate status metadata consistency
    if (status === 'in_progress' && (!resolutionStartedAt || !isNonEmptyString(row.resolution_started_by))) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    if (status === 'resolved' && (!resolutionStartedAt || !isNonEmptyString(row.resolution_started_by) || !resolvedAt || !isNonEmptyString(row.resolved_by) || !isNonEmptyString(row.replacement_preview_id))) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      correctionRequestId: row.id,
      status,
      participantPreviewId: row.participant_preview_id,
      comment: row.correction_comment,
      requestedAt,
      resolutionStartedAt,
      resolutionStartedBy: row.resolution_started_by ?? null,
      resolvedAt,
      resolvedBy: row.resolved_by ?? null,
      replacementPreviewId: row.replacement_preview_id ?? null,
    };
  }

  /**
   * Invokes the service-role-only get_project_publication_readiness RPC to derive
   * authoritative publication readiness. Fails closed on any unexpected response.
   */
  async getPublicationReadiness(params: {
    publicId: string;
    adminId: string;
    privateBucket: string;
  }): Promise<import('../domain/publicationReadiness').PublicationReadinessResult> {
    const { publicId, adminId, privateBucket } = params;

    if (!isNonEmptyString(publicId) || !isNonEmptyString(adminId) || !isNonEmptyString(privateBucket)) {
      return {
        ready: false,
        resultCode: 'READINESS_UNAVAILABLE',
        blockers: ['Publication readiness unavailable'],
      };
    }

    const { data, error } = await this.supabase.rpc('get_project_publication_readiness', {
      p_public_id: publicId,
      p_admin_id: adminId,
      p_private_bucket: privateBucket,
    });

    if (error || !data || typeof data !== 'object') {
      return {
        ready: false,
        resultCode: 'READINESS_UNAVAILABLE',
        blockers: ['Publication readiness unavailable'],
      };
    }

    const res = data as Record<string, unknown>;
    const validCodes = new Set<import('../domain/publicationReadiness').PublicationReadinessCode>([
      'READY', 'PROJECT_NOT_FOUND', 'READINESS_PERMISSION_DENIED', 'INVALID_PROJECT_STATE',
      'INVALID_SELECTION', 'INVALID_PRIVATE_BUCKET', 'NO_ACTIVE_PREVIEW', 'PREVIEW_NOT_CONFIRMED',
      'CORRECTION_UNRESOLVED', 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION', 'PROJECT_SNAPSHOT_STALE',
      'MEDIA_SNAPSHOT_STALE', 'READINESS_UNAVAILABLE',
    ]);
    if (
      typeof res.ready !== 'boolean' ||
      typeof res.resultCode !== 'string' ||
      !validCodes.has(res.resultCode as import('../domain/publicationReadiness').PublicationReadinessCode) ||
      !Array.isArray(res.blockers) ||
      !res.blockers.every((blocker) => typeof blocker === 'string')
    ) {
      return { ready: false, resultCode: 'READINESS_UNAVAILABLE', blockers: ['Publication readiness unavailable'] };
    }

    const resultCode = res.resultCode as import('../domain/publicationReadiness').PublicationReadinessCode;
    const confirmedPreviewId = isNonEmptyString(res.confirmedPreviewId) ? res.confirmedPreviewId : undefined;
    const confirmedAt = normalizeParticipantPreviewTimestamp(res.confirmedAt) ?? undefined;
    if (
      (res.ready && resultCode !== 'READY') ||
      (resultCode === 'READY' && (!confirmedPreviewId || !confirmedAt))
    ) {
      return { ready: false, resultCode: 'READINESS_UNAVAILABLE', blockers: ['Publication readiness unavailable'] };
    }

    return {
      ready: res.ready,
      resultCode,
      blockers: res.blockers,
      confirmedPreviewId,
      confirmedAt,
    };
  }
}
