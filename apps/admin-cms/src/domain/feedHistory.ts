export type PublicFeedVersionOperation =
  | 'publication'
  | 'removal'
  | 'rollback';

export interface PublicFeedVersionSummary {
  id: string;
  versionNumber: number;
  operationType: PublicFeedVersionOperation;
  createdAt: string;

  actorAdminId: string;
  actorName?: string | null;
  actorEmail?: string | null;

  affectedPublicId?: string | null;
  affectedProjectTitle?: string | null;

  recordCount: number;
  feedHash: string;

  previousVersionId?: string | null;
  restoredFromVersionId?: string | null;

  isCurrent: boolean;
}

export interface PublicFeedVersionDetail
  extends PublicFeedVersionSummary {
  artifactContent: string;
}

export type FeedRollbackAttemptState =
  | 'reserved'
  | 'prepared'
  | 'storage_written'
  | 'completed'
  | 'failed'
  | 'compensation_failed';

export interface FeedRollbackAttemptRecord {
  id: string;
  operationKey: string;
  targetVersionId: string;
  adminId: string;
  state: FeedRollbackAttemptState;

  executionToken: string;
  leaseExpiresAt: string;

  baselineRecordCount: number | null;
  baselineFeedHash: string | null;
  baselineFeedContent: string | null;

  targetRecordCount: number | null;
  targetFeedHash: string | null;
  targetFeedContent: string | null;

  artifactBoundAt: string | null;
  storageVerifiedAt: string | null;

  completedHistoryVersionId: string | null;

  failureCode: string | null;
  compensationFailureCode: string | null;

  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failedAt: string | null;
}

export type FeedRollbackRpcResult =
  Record<string, unknown> & {
    resultCode: string;
  };