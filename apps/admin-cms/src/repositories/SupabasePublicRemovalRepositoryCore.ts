import { SupabaseClient } from '@supabase/supabase-js';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';

export type PublicRemovalAttemptState = 'reserved' | 'prepared' | 'storage_written' | 'completed' | 'failed' | 'compensation_failed';
export const ACTIVE_PUBLIC_REMOVAL_STATES: PublicRemovalAttemptState[] = ['reserved', 'prepared', 'storage_written'];

export interface PublicRemovalAttemptRecord {
  id: string;
  projectId: string;
  publicId: string;
  adminId: string;
  archiveReason: string;
  candidateRecordCount: number | null;
  candidateFeedHash: string | null;
  candidateFeedContent: string | null;
  feedStorageBucket: string | null;
  feedStoragePath: string | null;
  feedPublicUrl: string | null;
  previousFeedExisted: boolean | null;
  previousFeedContent: string | null;
  artifactBoundAt: string | null;
  state: PublicRemovalAttemptState;
  executionToken: string;
  leaseExpiresAt: string;
  archiveAuditRecordId: string | null;
}

export interface ArchiveAuditRecord {
  id: string;
  projectId: string;
  adminId: string;
  actionTaken: string;
  fromStatus: string;
  toStatus: string;
  comments: string | null;
}

export type PublicRemovalRpcResult = Record<string, unknown> & { resultCode: string };

function toAttempt(row: Record<string, unknown>): PublicRemovalAttemptRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), publicId: String(row.public_id), adminId: String(row.admin_id),
    archiveReason: String(row.archive_reason), candidateRecordCount: row.candidate_record_count === null ? null : Number(row.candidate_record_count),
    candidateFeedHash: row.candidate_feed_hash === null ? null : String(row.candidate_feed_hash),
    candidateFeedContent: row.candidate_feed_content === null ? null : String(row.candidate_feed_content),
    feedStorageBucket: row.feed_storage_bucket === null ? null : String(row.feed_storage_bucket),
    feedStoragePath: row.feed_storage_path === null ? null : String(row.feed_storage_path),
    feedPublicUrl: row.feed_public_url === null ? null : String(row.feed_public_url),
    previousFeedExisted: row.previous_feed_existed === null ? null : row.previous_feed_existed === true,
    previousFeedContent: row.previous_feed_content === null ? null : String(row.previous_feed_content),
    artifactBoundAt: row.artifact_bound_at === null ? null : String(row.artifact_bound_at), state: row.state as PublicRemovalAttemptState,
    executionToken: String(row.execution_token), leaseExpiresAt: String(row.lease_expires_at),
    archiveAuditRecordId: row.archive_audit_record_id === null ? null : String(row.archive_audit_record_id),
  };
}

function rpc(data: unknown, error: { message?: string; code?: string } | null): PublicRemovalRpcResult {
  if (error) throw new Error(`Public removal persistence failed: ${error.code || 'UNKNOWN'}`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof (data as Record<string, unknown>).resultCode !== 'string') {
    throw new Error('Public removal persistence returned an invalid response.');
  }
  return data as PublicRemovalRpcResult;
}

export class SupabasePublicRemovalRepositoryCore {
  constructor(private readonly supabase: SupabaseClient, private readonly supabaseUrl: string) {}

  assertDisposableLocalEnvironment(): void {
    if (!isLoopbackUrl(this.supabaseUrl)) throw new Error('Controlled public removal requires a proven loopback Supabase environment.');
  }

  getPublicUrl(bucket: string, path: string): string {
    const { data } = this.supabase.storage.from(bucket).getPublicUrl(path);
    if (!data?.publicUrl) throw new Error('Public-removal feed URL could not be derived.');
    return data.publicUrl;
  }

  async getCompletedAttempt(publicId: string): Promise<PublicRemovalAttemptRecord | null> {
    const result = await this.supabase.from('public_removal_attempts').select('*').eq('public_id', publicId).eq('state', 'completed').maybeSingle();
    if (result.error) throw new Error('Public-removal attempt lookup failed.');
    return result.data ? toAttempt(result.data) : null;
  }

  async getRecoverableAttempt(publicId: string): Promise<PublicRemovalAttemptRecord | null> {
    const result = await this.supabase.from('public_removal_attempts').select('*').eq('public_id', publicId).in('state', ACTIVE_PUBLIC_REMOVAL_STATES).maybeSingle();
    if (result.error) throw new Error('Public-removal attempt lookup failed.');
    return result.data ? toAttempt(result.data) : null;
  }

  async getArchiveAuditRecord(id: string): Promise<ArchiveAuditRecord | null> {
    const result = await this.supabase.from('approval_records').select('id,project_id,admin_id,action_taken,from_status,to_status,comments').eq('id', id).maybeSingle();
    if (result.error) throw new Error('Archive audit lookup failed.');
    return result.data ? {
      id: String(result.data.id), projectId: String(result.data.project_id), adminId: String(result.data.admin_id),
      actionTaken: String(result.data.action_taken), fromStatus: String(result.data.from_status), toStatus: String(result.data.to_status),
      comments: result.data.comments === null ? null : String(result.data.comments),
    } : null;
  }

  async reserveAttempt(publicId: string, adminId: string, reason: string): Promise<PublicRemovalRpcResult> {
    const { data, error } = await this.supabase.rpc('reserve_public_removal_attempt', { p_public_id: publicId, p_admin_id: adminId, p_archive_reason: reason });
    return rpc(data, error);
  }

  async prepareAttempt(params: { attemptId: string; token: string; count: number; hash: string; content: string; bucket: string; path: string; publicUrl: string; previous: string }): Promise<PublicRemovalRpcResult> {
    const { data, error } = await this.supabase.rpc('prepare_public_removal_attempt', {
      p_attempt_id: params.attemptId, p_execution_token: params.token, p_candidate_record_count: params.count,
      p_candidate_feed_hash: params.hash, p_candidate_feed_content: params.content, p_feed_storage_bucket: params.bucket,
      p_feed_storage_path: params.path, p_feed_public_url: params.publicUrl, p_previous_feed_existed: true,
      p_previous_feed_content: params.previous,
    });
    return rpc(data, error);
  }

  async claimAttempt(publicId: string, adminId: string): Promise<PublicRemovalRpcResult> {
    const { data, error } = await this.supabase.rpc('claim_public_removal_attempt', { p_public_id: publicId, p_admin_id: adminId });
    return rpc(data, error);
  }

  async markStorageWritten(id: string, token: string, hash: string, count: number): Promise<PublicRemovalRpcResult> {
    const { data, error } = await this.supabase.rpc('mark_public_removal_storage_written', { p_attempt_id: id, p_execution_token: token, p_verified_feed_hash: hash, p_verified_record_count: count });
    return rpc(data, error);
  }

  async finalizeAttempt(id: string, token: string): Promise<PublicRemovalRpcResult> {
    const { data, error } = await this.supabase.rpc('finalize_public_removal_attempt', { p_attempt_id: id, p_execution_token: token });
    return rpc(data, error);
  }

  async failAttempt(id: string, token: string, failure: string, compensation?: string): Promise<PublicRemovalRpcResult> {
    const { data, error } = await this.supabase.rpc('fail_public_removal_attempt', { p_attempt_id: id, p_execution_token: token, p_failure_code: failure, p_compensation_failure_code: compensation ?? null });
    return rpc(data, error);
  }

  async downloadObject(bucket: string, path: string): Promise<Buffer | null> {
    const { data, error } = await this.supabase.storage.from(bucket).download(path);
    if (error) {
      if (/not found|does not exist|404/i.test(error.message || '')) return null;
      throw new Error('Public-removal storage download failed.');
    }
    return data ? Buffer.from(await data.arrayBuffer()) : null;
  }

}
