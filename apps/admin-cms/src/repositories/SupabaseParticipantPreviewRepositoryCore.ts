import { SupabaseClient } from '@supabase/supabase-js';
import { ParticipantPreviewExecutionError } from './ParticipantPreviewRepository';
import { ParticipantPreviewMediaRef, ParticipantPreviewSnapshot } from '../domain/participantPreview';

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
}
