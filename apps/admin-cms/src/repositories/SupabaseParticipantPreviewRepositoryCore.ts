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
  }): Promise<GeneratePreviewResult> {
    const { publicId, adminId, tokenHash, privateBucket, expiresInSeconds } = params;

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
    });

    if (error) {
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
      default:
        throw new ParticipantPreviewExecutionError('INPUT_INVALID');
    }

    if (
      !isNonEmptyString(res.previewId) ||
      !isNonEmptyString(res.publicId) ||
      !isNonEmptyString(res.createdAt) ||
      !isNonEmptyString(res.expiresAt)
    ) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      previewId: res.previewId,
      publicId: res.publicId,
      createdAt: res.createdAt,
      expiresAt: res.expiresAt,
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

    if (!isNonEmptyString(res.previewId) || !isNonEmptyString(res.publicId) || !isNonEmptyString(res.revokedAt)) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return {
      previewId: res.previewId,
      publicId: res.publicId,
      revokedAt: res.revokedAt,
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

    return {
      previewId: data.id,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
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

    if (
      !isNonEmptyString(res.previewId) ||
      typeof res.snapshot !== 'object' || res.snapshot === null ||
      !Array.isArray(res.mediaSnapshot) ||
      !isNonEmptyString(res.expiresAt)
    ) {
      return null;
    }

    return {
      previewId: res.previewId,
      snapshot: res.snapshot as ParticipantPreviewSnapshot,
      mediaSnapshot: res.mediaSnapshot as ParticipantPreviewMediaRef[],
      expiresAt: res.expiresAt,
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

    if (
      !isNonEmptyString(res.confirmationId) ||
      !isNonEmptyString(res.confirmedAt) ||
      typeof res.alreadyConfirmed !== 'boolean'
    ) {
      return null;
    }

    return {
      confirmationId: res.confirmationId,
      confirmedAt: res.confirmedAt,
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

    if (!isNonEmptyString(data.confirmed_at)) {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return { confirmedAt: data.confirmed_at };
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

    if (
      !isNonEmptyString(res.correctionRequestId) ||
      !isNonEmptyString(res.requestedAt) ||
      !isNonEmptyString(res.comment) ||
      typeof res.alreadyRequested !== 'boolean'
    ) {
      return null;
    }

    return {
      correctionRequestId: res.correctionRequestId,
      requestedAt: res.requestedAt,
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

    if (!isNonEmptyString(data.requested_at) || typeof data.correction_comment !== 'string') {
      throw new ParticipantPreviewExecutionError('RESPONSE_INVALID');
    }

    return { requestedAt: data.requested_at, comment: data.correction_comment };
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
}
