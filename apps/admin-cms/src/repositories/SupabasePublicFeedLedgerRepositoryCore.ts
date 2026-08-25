import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicationMediaBinding } from '../projects/publicationArtifact';
import type { PublicFeedArtifactMember } from '../feed/publicFeedArtifact';

export type PublicFeedOperationKind = 'activation' | 'publication' | 'removal' | 'rollback';
export type PublicFeedPublicationMode = 'normal' | 'deployment_reconciliation';
export type PublicFeedOperationState =
  | 'RESERVED' | 'PREPARED' | 'WRITE_STARTED' | 'CANDIDATE_OBSERVED'
  | 'DB_FINALIZED' | 'COMPLETED' | 'FAILED' | 'RECOVERY_REQUIRED';

export interface PublicFeedVersionRecord {
  id: string;
  versionNumber: number;
  operation: 'baseline' | 'publication' | 'removal' | 'rollback';
  publicationMode: PublicFeedPublicationMode | null;
  operationId: string;
  previousVersionId: string | null;
  restoredFromVersionId: string | null;
  projectId: string | null;
  affectedPublicId: string | null;
  authorizingActorId: string;
  completionActorId: string | null;
  artifactContent: string;
  byteCount: number;
  feedHash: string;
  recordCount: number;
  publishedSnapshotId: string | null;
  auditRecordId: string | null;
  createdAt: string;
}

export interface PublicFeedHeadRecord {
  generation: number;
  rollbackEnabled: boolean;
  currentVersion: PublicFeedVersionRecord;
}

export interface PublicFeedOperationRecord {
  id: string;
  operationKey: string;
  kind: PublicFeedOperationKind;
  publicationMode: PublicFeedPublicationMode | null;
  authorizingActorId: string;
  completionActorId: string | null;
  projectId: string | null;
  publicId: string | null;
  rollbackPreparationId: string | null;
  /**
   * Immutable authorization intent captured at reservation. Every field below participates in the
   * intent equality that gates any later claim or reuse of this durable operation, so a request
   * carrying materially different intent can never adopt it.
   */
  confirmedPreviewId: string | null;
  confirmedAt: string | null;
  privateMediaBucket: string | null;
  archiveReason: string | null;
  rollbackCapabilityRequested: boolean;
  baselineVersionId: string | null;
  baselineStorageExisted: boolean | null;
  baselineFeedHash: string | null;
  baselineRecordCount: number | null;
  baselineFeedContent: string | null;
  candidateFeedHash: string | null;
  candidateRecordCount: number | null;
  candidateFeedContent: string | null;
  mediaManifest: PublicationMediaBinding[] | null;
  state: PublicFeedOperationState;
  ownerEpoch: number;
  leaseExpiresAt: string;
  storageUncertaintyUntil: string | null;
  storageRequestGeneration: number;
  recoveryFromState: Exclude<PublicFeedOperationState, 'COMPLETED' | 'FAILED' | 'RECOVERY_REQUIRED'> | null;
  storageBucket: string;
  storagePath: string;
  feedPublicUrl: string | null;
  failureCode: string | null;
}

export interface FeedRollbackPreparationRecord {
  handle: string;
  actorId: string;
  targetVersionId: string;
  baselineVersionId: string;
  acknowledgementDigest: string;
  expiresAt: string;
  consumedAt: string | null;
  operationId: string | null;
}

export type PublicFeedRpcResult = Record<string, unknown> & { resultCode: string };

function rpcResult(data: unknown, error: { code?: string } | null): PublicFeedRpcResult {
  if (error) throw new Error(`PUBLIC_FEED_PERSISTENCE_FAILED_${error.code || 'UNKNOWN'}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || typeof (data as Record<string, unknown>).resultCode !== 'string') {
    throw new Error('PUBLIC_FEED_PERSISTENCE_RESPONSE_INVALID');
  }
  return data as PublicFeedRpcResult;
}

function version(row: Record<string, unknown>): PublicFeedVersionRecord {
  return {
    id: String(row.id), versionNumber: Number(row.version_number),
    operation: row.operation as PublicFeedVersionRecord['operation'],
    publicationMode: row.publication_mode === null ? null : row.publication_mode as PublicFeedPublicationMode,
    operationId: String(row.operation_id), previousVersionId: row.previous_version_id === null ? null : String(row.previous_version_id),
    restoredFromVersionId: row.restored_from_version_id === null ? null : String(row.restored_from_version_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    affectedPublicId: row.affected_public_id === null ? null : String(row.affected_public_id),
    authorizingActorId: String(row.authorizing_actor_id),
    completionActorId: row.completion_actor_id === null ? null : String(row.completion_actor_id),
    artifactContent: String(row.artifact_content), byteCount: Number(row.byte_count),
    feedHash: String(row.feed_hash), recordCount: Number(row.record_count),
    publishedSnapshotId: row.published_snapshot_id === null ? null : String(row.published_snapshot_id),
    auditRecordId: row.audit_record_id === null ? null : String(row.audit_record_id),
    createdAt: String(row.created_at),
  };
}

function operation(row: Record<string, unknown>): PublicFeedOperationRecord {
  return {
    id: String(row.id), operationKey: String(row.operation_key), kind: row.kind as PublicFeedOperationKind,
    publicationMode: row.publication_mode === null ? null : row.publication_mode as PublicFeedPublicationMode,
    authorizingActorId: String(row.authorizing_actor_id),
    completionActorId: row.completion_actor_id === null ? null : String(row.completion_actor_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    publicId: row.public_id === null ? null : String(row.public_id),
    rollbackPreparationId: row.rollback_preparation_id === null ? null : String(row.rollback_preparation_id),
    confirmedPreviewId: row.confirmed_preview_id === null ? null : String(row.confirmed_preview_id),
    confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
    privateMediaBucket: row.private_media_bucket === null ? null : String(row.private_media_bucket),
    archiveReason: row.archive_reason === null ? null : String(row.archive_reason),
    rollbackCapabilityRequested: row.rollback_capability_requested === true,
    baselineVersionId: row.baseline_version_id === null ? null : String(row.baseline_version_id),
    baselineStorageExisted: row.baseline_storage_existed === null ? null : row.baseline_storage_existed === true,
    baselineFeedHash: row.baseline_feed_hash === null ? null : String(row.baseline_feed_hash),
    baselineRecordCount: row.baseline_record_count === null ? null : Number(row.baseline_record_count),
    baselineFeedContent: row.baseline_feed_content === null ? null : String(row.baseline_feed_content),
    candidateFeedHash: row.candidate_feed_hash === null ? null : String(row.candidate_feed_hash),
    candidateRecordCount: row.candidate_record_count === null ? null : Number(row.candidate_record_count),
    candidateFeedContent: row.candidate_feed_content === null ? null : String(row.candidate_feed_content),
    mediaManifest: Array.isArray(row.media_manifest) ? row.media_manifest as PublicationMediaBinding[] : null,
    state: row.state as PublicFeedOperationState, ownerEpoch: Number(row.owner_epoch),
    leaseExpiresAt: String(row.lease_expires_at),
    storageUncertaintyUntil: row.storage_uncertainty_until === null ? null : String(row.storage_uncertainty_until),
    storageRequestGeneration: Number(row.storage_request_generation),
    recoveryFromState: row.recovery_from_state === null ? null
      : row.recovery_from_state as PublicFeedOperationRecord['recoveryFromState'],
    storageBucket: String(row.storage_bucket), storagePath: String(row.storage_path),
    feedPublicUrl: row.feed_public_url === null ? null : String(row.feed_public_url),
    failureCode: row.failure_code === null ? null : String(row.failure_code),
  };
}

export class SupabasePublicFeedLedgerRepositoryCore {
  constructor(private readonly supabase: SupabaseClient) {}

  async getHead(): Promise<PublicFeedHeadRecord | null> {
    const head = await this.supabase.from('public_feed_head').select('generation,rollback_enabled,current_version_id').eq('singleton', true).maybeSingle();
    if (head.error) throw new Error('PUBLIC_FEED_HEAD_READ_FAILED');
    if (!head.data) return null;
    const current = await this.supabase.from('public_feed_versions').select('*').eq('id', head.data.current_version_id).maybeSingle();
    if (current.error || !current.data) throw new Error('PUBLIC_FEED_HEAD_CORRUPT');
    return { generation: Number(head.data.generation), rollbackEnabled: head.data.rollback_enabled === true, currentVersion: version(current.data) };
  }

  async getVersionByNumber(versionNumber: number): Promise<PublicFeedVersionRecord | null> {
    const result = await this.supabase.from('public_feed_versions').select('*').eq('version_number', versionNumber).maybeSingle();
    if (result.error) throw new Error('PUBLIC_FEED_VERSION_READ_FAILED');
    return result.data ? version(result.data) : null;
  }

  async getVersionById(id: string): Promise<PublicFeedVersionRecord | null> {
    const result = await this.supabase.from('public_feed_versions').select('*').eq('id', id).maybeSingle();
    if (result.error) throw new Error('PUBLIC_FEED_VERSION_READ_FAILED');
    return result.data ? version(result.data) : null;
  }

  async getVersionByOperationId(operationId: string): Promise<PublicFeedVersionRecord | null> {
    const result = await this.supabase.from('public_feed_versions').select('*')
      .eq('operation_id', operationId).maybeSingle();
    if (result.error) throw new Error('PUBLIC_FEED_VERSION_READ_FAILED');
    return result.data ? version(result.data) : null;
  }

  async getRollbackPreparation(handle: string): Promise<FeedRollbackPreparationRecord | null> {
    const result = await this.supabase.from('feed_rollback_preparations')
      .select('handle,actor_id,target_version_id,baseline_version_id,acknowledgement_digest,expires_at,consumed_at,operation_id')
      .eq('handle', handle).maybeSingle();
    if (result.error) throw new Error('ROLLBACK_PREPARATION_READ_FAILED');
    if (!result.data) return null;
    return {
      handle: String(result.data.handle), actorId: String(result.data.actor_id),
      targetVersionId: String(result.data.target_version_id),
      baselineVersionId: String(result.data.baseline_version_id),
      acknowledgementDigest: String(result.data.acknowledgement_digest),
      expiresAt: String(result.data.expires_at),
      consumedAt: result.data.consumed_at === null ? null : String(result.data.consumed_at),
      operationId: result.data.operation_id === null ? null : String(result.data.operation_id),
    };
  }

  async getOperation(id: string): Promise<PublicFeedOperationRecord | null> {
    const result = await this.supabase.from('public_feed_operations').select('*').eq('id', id).maybeSingle();
    if (result.error) throw new Error('PUBLIC_FEED_OPERATION_READ_FAILED');
    return result.data ? operation(result.data) : null;
  }

  async getBlockingOperation(): Promise<PublicFeedOperationRecord | null> {
    const result = await this.supabase.from('public_feed_operations').select('*').in('state', [
      'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED',
    ]).limit(1).maybeSingle();
    if (result.error) throw new Error('PUBLIC_FEED_OPERATION_READ_FAILED');
    return result.data ? operation(result.data) : null;
  }

  async reserve(params: {
    operationKey: string | null; kind: PublicFeedOperationKind; mode: PublicFeedPublicationMode | null;
    adminId: string; publicId: string | null; ownerToken: string; confirmedPreviewId?: string | null;
    confirmedAt?: string | null; privateBucket?: string | null; archiveReason?: string | null;
    rollbackPreparationHandle?: string | null; rollbackAcknowledgement?: string | null;
    storageBucket: string; storagePath: string; rollbackCapability: boolean;
  }): Promise<PublicFeedRpcResult> {
    const { data, error } = await this.supabase.rpc('reserve_public_feed_operation', {
      p_operation_key: params.operationKey, p_kind: params.kind, p_publication_mode: params.mode,
      p_admin_id: params.adminId, p_public_id: params.publicId, p_owner_token: params.ownerToken,
      p_confirmed_preview_id: params.confirmedPreviewId ?? null, p_confirmed_at: params.confirmedAt ?? null,
      p_private_bucket: params.privateBucket ?? null, p_archive_reason: params.archiveReason ?? null,
      p_rollback_preparation_handle: params.rollbackPreparationHandle ?? null,
      p_rollback_acknowledgement: params.rollbackAcknowledgement ?? null,
      p_storage_bucket: params.storageBucket, p_storage_path: params.storagePath,
      p_rollback_capability: params.rollbackCapability,
    });
    return rpcResult(data, error);
  }

  async bind(params: {
    operationId: string; epoch: number; token: string; actorId: string; baselineVersionId: string | null;
    baselineStorageExisted: boolean; baselineHash: string | null; baselineCount: number | null;
    baselineContent: string | null; candidateHash: string; candidateCount: number; candidateContent: string;
    candidateMembers: PublicFeedArtifactMember[]; feedPublicUrl: string; mediaManifest: PublicationMediaBinding[];
  }): Promise<PublicFeedRpcResult> {
    const { data, error } = await this.supabase.rpc('bind_public_feed_operation', {
      p_operation_id: params.operationId, p_owner_epoch: params.epoch, p_owner_token: params.token,
      p_actor_id: params.actorId, p_baseline_version_id: params.baselineVersionId,
      p_baseline_storage_existed: params.baselineStorageExisted,
      p_baseline_feed_hash: params.baselineHash, p_baseline_record_count: params.baselineCount,
      p_baseline_feed_content: params.baselineContent, p_candidate_feed_hash: params.candidateHash,
      p_candidate_record_count: params.candidateCount, p_candidate_feed_content: params.candidateContent,
      p_candidate_members: params.candidateMembers,
      p_feed_public_url: params.feedPublicUrl, p_media_manifest: params.mediaManifest,
    });
    return rpcResult(data, error);
  }

  private async ownerRpc(name: string, params: Record<string, unknown>): Promise<PublicFeedRpcResult> {
    const { data, error } = await this.supabase.rpc(name, params);
    return rpcResult(data, error);
  }

  renew(operationId: string, epoch: number, token: string, actorId: string) {
    return this.ownerRpc('renew_public_feed_operation_lease', { p_operation_id: operationId, p_owner_epoch: epoch, p_owner_token: token, p_actor_id: actorId });
  }
  markWriteStarted(operationId: string, epoch: number, token: string, actorId: string) {
    return this.ownerRpc('mark_public_feed_write_started', { p_operation_id: operationId, p_owner_epoch: epoch, p_owner_token: token, p_actor_id: actorId });
  }
  observeCandidate(operationId: string, epoch: number, token: string, actorId: string, hash: string, count: number) {
    return this.ownerRpc('mark_public_feed_candidate_observed', { p_operation_id: operationId, p_owner_epoch: epoch, p_owner_token: token, p_actor_id: actorId, p_observed_hash: hash, p_observed_record_count: count });
  }
  finalize(operationId: string, epoch: number, token: string, actorId: string) {
    return this.ownerRpc('finalize_public_feed_operation', { p_operation_id: operationId, p_owner_epoch: epoch, p_owner_token: token, p_completion_actor_id: actorId });
  }
  complete(operationId: string, epoch: number, token: string, actorId: string, hash: string, count: number) {
    return this.ownerRpc('complete_public_feed_operation', { p_operation_id: operationId, p_owner_epoch: epoch, p_owner_token: token, p_actor_id: actorId, p_observed_hash: hash, p_observed_record_count: count });
  }
  fail(operationId: string, epoch: number, token: string, actorId: string, code: string) {
    return this.ownerRpc('fail_public_feed_operation', { p_operation_id: operationId, p_owner_epoch: epoch, p_owner_token: token, p_actor_id: actorId, p_failure_code: code });
  }
  requireRecovery(operationId: string, epoch: number, token: string, actorId: string, code: string, hash: string | null, count: number | null) {
    return this.ownerRpc('require_public_feed_recovery', { p_operation_id: operationId, p_owner_epoch: epoch, p_owner_token: token, p_actor_id: actorId, p_failure_code: code, p_observed_hash: hash, p_observed_record_count: count });
  }
  async claim(operationId: string, adminId: string, newToken: string): Promise<PublicFeedRpcResult> {
    const { data, error } = await this.supabase.rpc('claim_public_feed_operation', { p_operation_id: operationId, p_admin_id: adminId, p_new_owner_token: newToken });
    return rpcResult(data, error);
  }
  async prepareRollback(adminId: string, targetVersionNumber: number, hash: string, count: number, drift: object): Promise<PublicFeedRpcResult> {
    const { data, error } = await this.supabase.rpc('prepare_public_feed_rollback', {
      p_admin_id: adminId, p_target_version_number: targetVersionNumber,
      p_observed_storage_hash: hash, p_observed_storage_record_count: count,
      p_lifecycle_drift: drift,
    });
    return rpcResult(data, error);
  }
}
