import { SupabaseClient } from '@supabase/supabase-js';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import { PublicationMediaBinding, PublicationMediaSource } from '../projects/publicationArtifact';

export type PublicationAttemptState =
  | 'reserved'
  | 'prepared'
  | 'storage_written'
  | 'completed'
  | 'failed'
  | 'compensation_failed';

/** States that hold or block the single global publication slot. */
export const ACTIVE_PUBLICATION_ATTEMPT_STATES: PublicationAttemptState[] = ['reserved', 'prepared', 'storage_written'];

export interface PublicationAttemptRecord {
  id: string;
  projectId: string;
  publicId: string;
  adminId: string;
  confirmedPreviewId: string;
  confirmedAt: string;
  /** Artifact evidence is null until prepare_publication_attempt binds it to the reservation. */
  candidateRecordCount: number | null;
  candidateFeedHash: string | null;
  candidateFeedContent: string | null;
  feedStorageBucket: string | null;
  feedStoragePath: string | null;
  feedPublicUrl: string | null;
  previousFeedExisted: boolean | null;
  previousFeedContent: string | null;
  mediaManifest: PublicationMediaBinding[] | null;
  artifactBoundAt: string | null;
  state: PublicationAttemptState;
  executionToken: string;
  leaseExpiresAt: string;
  publishedSnapshotId: string | null;
  publishAuditRecordId: string | null;
}

export interface PublishedSnapshotRecord {
  id: string;
  recordCount: number;
  feedHash: string;
  storageBucket: string;
  storagePath: string;
  publicUrl: string;
  createdBy: string | null;
}

export interface PublishAuditRecord {
  id: string;
  projectId: string;
  adminId: string;
  actionTaken: string;
  fromStatus: string;
  toStatus: string;
}

export type PublicationRpcResult = Record<string, unknown> & { resultCode: string };

function toAttemptRecord(row: Record<string, unknown>): PublicationAttemptRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    publicId: String(row.public_id),
    adminId: String(row.admin_id),
    confirmedPreviewId: String(row.confirmed_preview_id),
    confirmedAt: String(row.confirmed_at),
    candidateRecordCount: row.candidate_record_count === null ? null : Number(row.candidate_record_count),
    candidateFeedHash: row.candidate_feed_hash === null ? null : String(row.candidate_feed_hash),
    candidateFeedContent: row.candidate_feed_content === null ? null : String(row.candidate_feed_content),
    feedStorageBucket: row.feed_storage_bucket === null ? null : String(row.feed_storage_bucket),
    feedStoragePath: row.feed_storage_path === null ? null : String(row.feed_storage_path),
    feedPublicUrl: row.feed_public_url === null ? null : String(row.feed_public_url),
    previousFeedExisted: row.previous_feed_existed === null ? null : row.previous_feed_existed === true,
    previousFeedContent: row.previous_feed_content === null ? null : String(row.previous_feed_content),
    mediaManifest: Array.isArray(row.media_manifest) ? row.media_manifest as PublicationMediaBinding[] : null,
    artifactBoundAt: row.artifact_bound_at === null ? null : String(row.artifact_bound_at),
    state: row.state as PublicationAttemptState,
    executionToken: String(row.execution_token),
    leaseExpiresAt: String(row.lease_expires_at),
    publishedSnapshotId: row.published_snapshot_id === null ? null : String(row.published_snapshot_id),
    publishAuditRecordId: row.publish_audit_record_id === null ? null : String(row.publish_audit_record_id),
  };
}

function requireRpcResult(data: unknown, error: { message?: string; code?: string } | null): PublicationRpcResult {
  if (error) {
    if ((error.message || '').includes('PUBLICATION_IN_PROGRESS')) {
      return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    }
    throw new Error(`Publication persistence failed: ${error.code || 'UNKNOWN'}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof (data as Record<string, unknown>).resultCode !== 'string') {
    throw new Error('Publication persistence returned an invalid response.');
  }
  return data as PublicationRpcResult;
}

export class SupabasePublicationExecutionRepositoryCore {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly supabaseUrl: string,
  ) {}

  assertDisposableLocalEnvironment(): void {
    if (!isLoopbackUrl(this.supabaseUrl)) {
      throw new Error('Controlled publication requires a proven loopback Supabase environment.');
    }
  }

  getPublicUrl(bucket: string, storagePath: string): string {
    const { data } = this.supabase.storage.from(bucket).getPublicUrl(storagePath);
    if (!data?.publicUrl) throw new Error('Publication public URL could not be derived.');
    return data.publicUrl;
  }

  async listProjectMedia(publicId: string): Promise<PublicationMediaSource[]> {
    const project = await this.supabase.from('projects').select('id').eq('public_id', publicId).is('deleted_at', null).maybeSingle();
    if (project.error) throw new Error('Publication project media lookup failed.');
    if (!project.data) return [];
    const result = await this.supabase.from('media_assets').select(
      'id,project_id,asset_type,gallery_position,file_name,storage_bucket,storage_path,public_url,public_storage_bucket,public_storage_path,mime_type,file_size_bytes,is_public_approved,alt_text_public',
    ).eq('project_id', project.data.id).order('asset_type', { ascending: true });
    if (result.error) throw new Error('Publication media lookup failed.');
    return (result.data ?? []).map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      assetType: String(row.asset_type),
      galleryPosition:
        row.gallery_position === null
          ? null
          : Number(row.gallery_position),
      fileName: String(row.file_name),
      storageBucket: String(row.storage_bucket),
      storagePath: String(row.storage_path),
      publicUrl: row.public_url === null ? null : String(row.public_url),
      publicStorageBucket: row.public_storage_bucket === null ? null : String(row.public_storage_bucket),
      publicStoragePath: row.public_storage_path === null ? null : String(row.public_storage_path),
      mimeType: String(row.mime_type || ''),
      fileSizeBytes: Number(row.file_size_bytes),
      isPublicApproved: row.is_public_approved === true,
      altTextPublic: row.alt_text_public === null ? null : String(row.alt_text_public),
    }));
  }

  /**
   * The single completed publication attempt for a target, if one exists. The partial unique
   * index guarantees at most one, so this never falls back to "latest row wins" across a
   * history that may also contain failed attempts.
   */
  async getCompletedAttempt(publicId: string): Promise<PublicationAttemptRecord | null> {
    const result = await this.supabase.from('publication_attempts').select('*')
      .eq('public_id', publicId).eq('state', 'completed').maybeSingle();
    if (result.error) throw new Error('Publication attempt lookup failed.');
    return result.data ? toAttemptRecord(result.data) : null;
  }

  /**
   * The attempt for a target that still holds the global publication slot and may be resumed.
   * The partial unique global index guarantees at most one such row exists repository-wide.
   */
  async getRecoverableAttempt(publicId: string): Promise<PublicationAttemptRecord | null> {
    const result = await this.supabase.from('publication_attempts').select('*')
      .eq('public_id', publicId).in('state', ACTIVE_PUBLICATION_ATTEMPT_STATES).maybeSingle();
    if (result.error) throw new Error('Publication attempt lookup failed.');
    return result.data ? toAttemptRecord(result.data) : null;
  }

  async getPublishedSnapshot(snapshotId: string): Promise<PublishedSnapshotRecord | null> {
    const result = await this.supabase.from('published_snapshots')
      .select('id,record_count,feed_hash,storage_bucket,storage_path,public_url,created_by').eq('id', snapshotId).maybeSingle();
    if (result.error) throw new Error('Published snapshot lookup failed.');
    if (!result.data) return null;
    return {
      id: String(result.data.id),
      recordCount: Number(result.data.record_count),
      feedHash: String(result.data.feed_hash),
      storageBucket: String(result.data.storage_bucket),
      storagePath: String(result.data.storage_path),
      publicUrl: String(result.data.public_url),
      createdBy: result.data.created_by === null ? null : String(result.data.created_by),
    };
  }

  async getPublishAuditRecord(auditRecordId: string): Promise<PublishAuditRecord | null> {
    const result = await this.supabase.from('approval_records')
      .select('id,project_id,admin_id,action_taken,from_status,to_status').eq('id', auditRecordId).maybeSingle();
    if (result.error) throw new Error('Publish audit lookup failed.');
    if (!result.data) return null;
    return {
      id: String(result.data.id),
      projectId: String(result.data.project_id),
      adminId: String(result.data.admin_id),
      actionTaken: String(result.data.action_taken),
      fromStatus: String(result.data.from_status),
      toStatus: String(result.data.to_status),
    };
  }

  async reserveAttempt(params: {
    publicId: string;
    adminId: string;
    privateBucket: string;
    confirmedPreviewId: string;
    confirmedAt: string;
  }): Promise<PublicationRpcResult> {
    const { data, error } = await this.supabase.rpc('reserve_publication_attempt', {
      p_public_id: params.publicId,
      p_admin_id: params.adminId,
      p_private_bucket: params.privateBucket,
      p_confirmed_preview_id: params.confirmedPreviewId,
      p_confirmed_at: params.confirmedAt,
    });
    return requireRpcResult(data, error);
  }

  async prepareAttempt(params: {
    attemptId: string;
    executionToken: string;
    privateBucket: string;
    recordCount: number;
    feedHash: string;
    content: string;
    feedBucket: string;
    feedPath: string;
    feedPublicUrl: string;
    previousFeedContent: string | null;
    mediaManifest: PublicationMediaBinding[];
  }): Promise<PublicationRpcResult> {
    const { data, error } = await this.supabase.rpc('prepare_publication_attempt', {
      p_attempt_id: params.attemptId,
      p_execution_token: params.executionToken,
      p_private_bucket: params.privateBucket,
      p_candidate_record_count: params.recordCount,
      p_candidate_feed_hash: params.feedHash,
      p_candidate_feed_content: params.content,
      p_feed_storage_bucket: params.feedBucket,
      p_feed_storage_path: params.feedPath,
      p_feed_public_url: params.feedPublicUrl,
      p_previous_feed_existed: params.previousFeedContent !== null,
      p_previous_feed_content: params.previousFeedContent,
      p_media_manifest: params.mediaManifest,
    });
    return requireRpcResult(data, error);
  }

  async claimAttempt(publicId: string, adminId: string): Promise<PublicationRpcResult> {
    const { data, error } = await this.supabase.rpc('claim_publication_attempt', { p_public_id: publicId, p_admin_id: adminId });
    return requireRpcResult(data, error);
  }

  async markStorageWritten(attemptId: string, executionToken: string, feedHash: string, recordCount: number): Promise<PublicationRpcResult> {
    const { data, error } = await this.supabase.rpc('mark_publication_attempt_storage_written', {
      p_attempt_id: attemptId,
      p_execution_token: executionToken,
      p_verified_feed_hash: feedHash,
      p_verified_record_count: recordCount,
    });
    return requireRpcResult(data, error);
  }

  async finalizeAttempt(attemptId: string, executionToken: string, privateBucket: string): Promise<PublicationRpcResult> {
    const { data, error } = await this.supabase.rpc('finalize_publication_attempt', {
      p_attempt_id: attemptId,
      p_execution_token: executionToken,
      p_private_bucket: privateBucket,
    });
    return requireRpcResult(data, error);
  }

  async failAttempt(attemptId: string, executionToken: string, failureCode: string, compensationFailureCode?: string): Promise<PublicationRpcResult> {
    const { data, error } = await this.supabase.rpc('fail_publication_attempt', {
      p_attempt_id: attemptId,
      p_execution_token: executionToken,
      p_failure_code: failureCode,
      p_compensation_failure_code: compensationFailureCode ?? null,
    });
    return requireRpcResult(data, error);
  }

  async downloadObject(bucket: string, storagePath: string): Promise<Buffer | null> {
    const { data, error } = await this.supabase.storage.from(bucket).download(storagePath);
    if (error) {
      if (/not found|does not exist|404/i.test(error.message || '')) return null;
      throw new Error('Publication storage download failed.');
    }
    if (!data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  async uploadNewObject(bucket: string, storagePath: string, content: Buffer, contentType: string): Promise<boolean> {
    const result = await this.supabase.storage.from(bucket).upload(storagePath, content, { contentType, upsert: false });
    if (!result.error) return true;
    if (!/already exists|duplicate/i.test(result.error.message || '')) throw new Error('Publication media upload failed.');
    const existing = await this.downloadObject(bucket, storagePath);
    if (!existing || !existing.equals(content)) throw new Error('Publication media storage conflict.');
    return false;
  }

  async removeObjects(bucket: string, storagePaths: string[]): Promise<void> {
    if (storagePaths.length === 0) return;
    const { error } = await this.supabase.storage.from(bucket).remove(storagePaths);
    if (error) throw new Error('Publication storage cleanup failed.');
  }
}
