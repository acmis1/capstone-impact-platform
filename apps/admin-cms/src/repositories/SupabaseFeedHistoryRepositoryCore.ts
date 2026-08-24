import { SupabaseClient } from '@supabase/supabase-js';

import {
  FeedRollbackAttemptRecord,
  FeedRollbackAttemptState,
  FeedRollbackRpcResult,
  PublicFeedVersionDetail,
  PublicFeedVersionOperation,
  PublicFeedVersionSummary,
} from '../domain/feedHistory';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseVersionOperation(
  value: unknown,
): PublicFeedVersionOperation {
  if (
    value === 'publication' ||
    value === 'removal' ||
    value === 'rollback'
  ) {
    return value;
  }

  throw new Error(
    'Feed history returned an invalid operation type.',
  );
}

function parseRollbackState(
  value: unknown,
): FeedRollbackAttemptState {
  if (
    value === 'reserved' ||
    value === 'prepared' ||
    value === 'storage_written' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'compensation_failed'
  ) {
    return value;
  }

  throw new Error(
    'Feed rollback persistence returned an invalid state.',
  );
}

function optionalString(
  value: unknown,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

function toVersionSummary(
  row: Record<string, unknown>,
  currentVersionId: string | null,
): PublicFeedVersionSummary {
  const versionNumber = Number(row.version_number);
  const recordCount = Number(row.record_count);

  if (
    !isNonEmptyString(row.id) ||
    !Number.isSafeInteger(versionNumber) ||
    versionNumber <= 0 ||
    !isNonEmptyString(row.created_at) ||
    !isNonEmptyString(row.actor_admin_id) ||
    !Number.isSafeInteger(recordCount) ||
    recordCount < 0 ||
    !isNonEmptyString(row.feed_hash)
  ) {
    throw new Error(
      'Feed history returned malformed version evidence.',
    );
  }

  const actorRelation = row.admin_users;

  let actorName: string | null = null;
  let actorEmail: string | null = null;

  if (
    actorRelation &&
    typeof actorRelation === 'object' &&
    !Array.isArray(actorRelation)
  ) {
    const actor = actorRelation as Record<
      string,
      unknown
    >;

    actorName =
      typeof actor.full_name === 'string'
        ? actor.full_name
        : null;

    actorEmail =
      typeof actor.email === 'string'
        ? actor.email
        : null;
  }

  const projectRelation = row.projects;

  let affectedProjectTitle: string | null = null;

  if (
    projectRelation &&
    typeof projectRelation === 'object' &&
    !Array.isArray(projectRelation)
  ) {
    const project = projectRelation as Record<
      string,
      unknown
    >;

    affectedProjectTitle =
      typeof project.title === 'string'
        ? project.title
        : null;
  }

  return {
    id: row.id,
    versionNumber,
    operationType: parseVersionOperation(
      row.operation_type,
    ),
    createdAt: row.created_at,

    actorAdminId: row.actor_admin_id,
    actorName,
    actorEmail,

    affectedPublicId: optionalString(
      row.affected_public_id,
    ),
    affectedProjectTitle,

    recordCount,
    feedHash: row.feed_hash,

    previousVersionId: optionalString(
      row.previous_version_id,
    ),

    restoredFromVersionId: optionalString(
      row.restored_from_version_id,
    ),

    isCurrent: row.id === currentVersionId,
  };
}

function toRollbackAttempt(
  row: Record<string, unknown>,
): FeedRollbackAttemptRecord {
  if (
    !isNonEmptyString(row.id) ||
    !isNonEmptyString(row.operation_key) ||
    !isNonEmptyString(row.target_version_id) ||
    !isNonEmptyString(row.admin_id) ||
    !isNonEmptyString(row.execution_token) ||
    !isNonEmptyString(row.lease_expires_at) ||
    !isNonEmptyString(row.created_at) ||
    !isNonEmptyString(row.updated_at)
  ) {
    throw new Error(
      'Feed rollback persistence returned malformed attempt evidence.',
    );
  }

  return {
    id: row.id,
    operationKey: row.operation_key,
    targetVersionId: row.target_version_id,
    adminId: row.admin_id,
    state: parseRollbackState(row.state),

    executionToken: row.execution_token,
    leaseExpiresAt: row.lease_expires_at,

    baselineRecordCount:
      row.baseline_record_count === null ||
      row.baseline_record_count === undefined
        ? null
        : Number(row.baseline_record_count),

    baselineFeedHash: optionalString(
      row.baseline_feed_hash,
    ),

    baselineFeedContent: optionalString(
      row.baseline_feed_content,
    ),

    targetRecordCount:
      row.target_record_count === null ||
      row.target_record_count === undefined
        ? null
        : Number(row.target_record_count),

    targetFeedHash: optionalString(
      row.target_feed_hash,
    ),

    targetFeedContent: optionalString(
      row.target_feed_content,
    ),

    artifactBoundAt: optionalString(
      row.artifact_bound_at,
    ),

    storageVerifiedAt: optionalString(
      row.storage_verified_at,
    ),

    completedHistoryVersionId: optionalString(
      row.completed_history_version_id,
    ),

    failureCode: optionalString(
      row.failure_code,
    ),

    compensationFailureCode: optionalString(
      row.compensation_failure_code,
    ),

    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: optionalString(
      row.completed_at,
    ),
    failedAt: optionalString(row.failed_at),
  };
}

function requireRpcResult(
  data: unknown,
  error: {
    message?: string;
    code?: string;
  } | null,
): FeedRollbackRpcResult {
  if (error) {
    throw new Error(
      `Feed rollback persistence failed: ${
        error.code || 'UNKNOWN'
      }`,
    );
  }

  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof (
      data as Record<string, unknown>
    ).resultCode !== 'string'
  ) {
    throw new Error(
      'Feed rollback persistence returned an invalid response.',
    );
  }

  return data as FeedRollbackRpcResult;
}

export class SupabaseFeedHistoryRepositoryCore {
  constructor(
    private readonly supabase: SupabaseClient,
  ) {}

  async getCurrentVersionId(): Promise<
    string | null
  > {
    const { data, error } = await this.supabase
      .from('public_feed_head')
      .select('version_id')
      .eq('singleton', true)
      .maybeSingle();

    if (error) {
      throw new Error(
        'Current public-feed version could not be loaded.',
      );
    }

    if (!data) {
      return null;
    }

    if (!isNonEmptyString(data.version_id)) {
      throw new Error(
        'Current public-feed version evidence is malformed.',
      );
    }

    return data.version_id;
  }

  async listVersions(
    limit = 100,
  ): Promise<PublicFeedVersionSummary[]> {
    const safeLimit = Math.min(
      Math.max(Math.trunc(limit), 1),
      500,
    );

    const currentVersionId =
      await this.getCurrentVersionId();

    const { data, error } = await this.supabase
      .from('public_feed_versions')
      .select(
        `
          id,
          version_number,
          operation_type,
          created_at,
          actor_admin_id,
          affected_public_id,
          record_count,
          feed_hash,
          previous_version_id,
          restored_from_version_id,
          admin_users!public_feed_versions_actor_admin_id_fkey(
            full_name,
            email
          ),
          projects!public_feed_versions_affected_project_id_fkey(
            title
          )
        `,
      )
      .order('version_number', {
        ascending: false,
      })
      .limit(safeLimit);

    if (error) {
      throw new Error(
        'Public-feed history could not be loaded.',
      );
    }

    return (data ?? []).map((row) =>
      toVersionSummary(
        row as unknown as Record<
          string,
          unknown
        >,
        currentVersionId,
      ),
    );
  }

  async getVersion(
    versionId: string,
  ): Promise<PublicFeedVersionDetail | null> {
    if (!isNonEmptyString(versionId)) {
      return null;
    }

    const currentVersionId =
      await this.getCurrentVersionId();

    const { data, error } = await this.supabase
      .from('public_feed_versions')
      .select(
        `
          id,
          version_number,
          operation_type,
          created_at,
          actor_admin_id,
          affected_public_id,
          record_count,
          feed_hash,
          artifact_content,
          previous_version_id,
          restored_from_version_id,
          admin_users!public_feed_versions_actor_admin_id_fkey(
            full_name,
            email
          ),
          projects!public_feed_versions_affected_project_id_fkey(
            title
          )
        `,
      )
      .eq('id', versionId)
      .maybeSingle();

    if (error) {
      throw new Error(
        'Historical public-feed version could not be loaded.',
      );
    }

    if (!data) {
      return null;
    }

    const row =
      data as unknown as Record<
        string,
        unknown
      >;

    const summary = toVersionSummary(
      row,
      currentVersionId,
    );

    if (
      typeof row.artifact_content !== 'string'
    ) {
      throw new Error(
        'Historical public-feed artifact is incomplete.',
      );
    }

    return {
      ...summary,
      artifactContent: row.artifact_content,
    };
  }

    async getVersionByNumber(
    versionNumber: number,
  ): Promise<PublicFeedVersionDetail | null> {
    if (
      !Number.isSafeInteger(versionNumber) ||
      versionNumber <= 0
    ) {
      return null;
    }

    const currentVersionId =
      await this.getCurrentVersionId();

    const { data, error } = await this.supabase
      .from('public_feed_versions')
      .select(
        `
          id,
          version_number,
          operation_type,
          created_at,
          actor_admin_id,
          affected_public_id,
          record_count,
          feed_hash,
          artifact_content,
          previous_version_id,
          restored_from_version_id,
          admin_users!public_feed_versions_actor_admin_id_fkey(
            full_name,
            email
          ),
          projects!public_feed_versions_affected_project_id_fkey(
            title
          )
        `,
      )
      .eq('version_number', versionNumber)
      .maybeSingle();

    if (error) {
      throw new Error(
        'Historical public-feed version could not be loaded.',
      );
    }

    if (!data) {
      return null;
    }

    const row =
      data as unknown as Record<string, unknown>;

    const summary = toVersionSummary(
      row,
      currentVersionId,
    );

    if (
      typeof row.artifact_content !== 'string'
    ) {
      throw new Error(
        'Historical public-feed artifact is incomplete.',
      );
    }

    return {
      ...summary,
      artifactContent: row.artifact_content,
    };
  }

  async getAttemptByOperationKey(
    operationKey: string,
  ): Promise<FeedRollbackAttemptRecord | null> {
    if (!isNonEmptyString(operationKey)) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('feed_rollback_attempts')
      .select('*')
      .eq('operation_key', operationKey)
      .maybeSingle();

    if (error) {
      throw new Error(
        'Feed rollback attempt lookup failed.',
      );
    }

    return data
      ? toRollbackAttempt(
          data as unknown as Record<
            string,
            unknown
          >,
        )
      : null;
  }

  async getRecoverableAttempt(
    operationKey: string,
  ): Promise<FeedRollbackAttemptRecord | null> {
    if (!isNonEmptyString(operationKey)) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('feed_rollback_attempts')
      .select('*')
      .eq('operation_key', operationKey)
      .in('state', [
        'reserved',
        'prepared',
        'storage_written',
        'compensation_failed',
      ])
      .maybeSingle();

    if (error) {
      throw new Error(
        'Recoverable feed rollback attempt lookup failed.',
      );
    }

    return data
      ? toRollbackAttempt(
          data as unknown as Record<
            string,
            unknown
          >,
        )
      : null;
  }

  async reserveRollback(params: {
    operationKey: string;
    targetVersionId: string;
    adminId: string;
  }): Promise<FeedRollbackRpcResult> {
    const { data, error } =
      await this.supabase.rpc(
        'reserve_feed_rollback_attempt',
        {
          p_operation_key:
            params.operationKey,
          p_target_version_id:
            params.targetVersionId,
          p_admin_id: params.adminId,
        },
      );

    return requireRpcResult(data, error);
  }

  async prepareRollback(params: {
    attemptId: string;
    executionToken: string;

    baselineRecordCount: number;
    baselineFeedHash: string;
    baselineFeedContent: string;

    targetRecordCount: number;
    targetFeedHash: string;
    targetFeedContent: string;
  }): Promise<FeedRollbackRpcResult> {
    const { data, error } =
      await this.supabase.rpc(
        'prepare_feed_rollback_attempt',
        {
          p_attempt_id: params.attemptId,
          p_execution_token:
            params.executionToken,

          p_baseline_record_count:
            params.baselineRecordCount,

          p_baseline_feed_hash:
            params.baselineFeedHash,

          p_baseline_feed_content:
            params.baselineFeedContent,

          p_target_record_count:
            params.targetRecordCount,

          p_target_feed_hash:
            params.targetFeedHash,

          p_target_feed_content:
            params.targetFeedContent,
        },
      );

    return requireRpcResult(data, error);
  }

  async claimRollback(
    operationKey: string,
    adminId: string,
  ): Promise<FeedRollbackRpcResult> {
    const { data, error } =
      await this.supabase.rpc(
        'claim_feed_rollback_attempt',
        {
          p_operation_key: operationKey,
          p_admin_id: adminId,
        },
      );

    return requireRpcResult(data, error);
  }

  async markRollbackStorageWritten(params: {
    attemptId: string;
    executionToken: string;
    feedHash: string;
    recordCount: number;
  }): Promise<FeedRollbackRpcResult> {
    const { data, error } =
      await this.supabase.rpc(
        'mark_feed_rollback_storage_written',
        {
          p_attempt_id: params.attemptId,
          p_execution_token:
            params.executionToken,

          p_verified_feed_hash:
            params.feedHash,

          p_verified_record_count:
            params.recordCount,
        },
      );

    return requireRpcResult(data, error);
  }

  async finalizeRollback(params: {
    attemptId: string;
    executionToken: string;
  }): Promise<FeedRollbackRpcResult> {
    const { data, error } =
      await this.supabase.rpc(
        'finalize_feed_rollback_attempt',
        {
          p_attempt_id: params.attemptId,
          p_execution_token:
            params.executionToken,
        },
      );

    return requireRpcResult(data, error);
  }

    async failRollback(params: {
    attemptId: string;
    executionToken: string;
    failureCode: string;
    compensationFailureCode?: string;
  }): Promise<FeedRollbackRpcResult> {
    const { data, error } =
      await this.supabase.rpc(
        'fail_feed_rollback_attempt',
        {
          p_attempt_id: params.attemptId,
          p_execution_token:
            params.executionToken,
          p_failure_code:
            params.failureCode,
          p_compensation_failure_code:
            params.compensationFailureCode ??
            null,
        },
      );

    return requireRpcResult(data, error);
  }

  // ============================================================
  // RollbackExecutionRecorder adapter methods
  //
  // These aliases allow SupabaseFeedHistoryRepositoryCore
  // to be passed directly into localFeedRollbackExecution
  // without duplicating persistence logic.
  // ============================================================

  async reserve(params: {
    operationKey: string;
    targetVersionId: string;
    adminId: string;
  }): Promise<FeedRollbackRpcResult> {
    return this.reserveRollback(params);
  }

  async prepare(params: {
    attemptId: string;
    executionToken: string;

    baselineRecordCount: number;
    baselineFeedHash: string;
    baselineFeedContent: string;

    targetRecordCount: number;
    targetFeedHash: string;
    targetFeedContent: string;
  }): Promise<FeedRollbackRpcResult> {
    return this.prepareRollback(params);
  }

  async markStorageWritten(params: {
    attemptId: string;
    executionToken: string;
    feedHash: string;
    recordCount: number;
  }): Promise<FeedRollbackRpcResult> {
    return this.markRollbackStorageWritten(
      params,
    );
  }

  async finalize(params: {
    attemptId: string;
    executionToken: string;
  }): Promise<FeedRollbackRpcResult> {
    return this.finalizeRollback(params);
  }

  async fail(params: {
    attemptId: string;
    executionToken: string;
    failureCode: string;
    compensationFailureCode?: string;
  }): Promise<FeedRollbackRpcResult> {
    return this.failRollback(params);
  }
}
