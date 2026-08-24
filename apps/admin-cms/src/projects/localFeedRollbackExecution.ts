import crypto from 'node:crypto';

import type {
  FeedRollbackRpcResult,
  PublicFeedVersionDetail,
} from '../domain/feedHistory';

import {
  FeedArtifactVerificationError,
  verifyHistoricalFeedArtifact,
} from '../feed/feedArtifactIntegrity';

import {
  serializePublicFeedArtifact,
} from '../feed/serializePublicFeedArtifact';

import {
  validatePublicFeed,
} from '../feed/validatePublicFeed';

export const ROLLBACK_ACKNOWLEDGEMENT =
  'I understand this will replace the Local canonical public feed with the selected verified historical version.' as const;

export type RollbackExecutionResult =
  | {
      resultCode: 'COMPLETED';
      attemptId: string;
      historyVersionId: string;
    }
  | {
      resultCode: 'ALREADY_COMPLETED';
      attemptId: string;
      historyVersionId?: string;
    }
  | {
      resultCode:
        | 'ACKNOWLEDGEMENT_REQUIRED'
        | 'LOCAL_EXECUTION_REQUIRED'
        | 'HISTORICAL_VERSION_NOT_FOUND'
        | 'HISTORICAL_ARTIFACT_INVALID'
        | 'CURRENT_FEED_MISSING'
        | 'CURRENT_FEED_INVALID'
        | 'STALE_PREPARATION'
        | 'PUBLICATION_IN_PROGRESS'
        | 'ROLLBACK_IN_PROGRESS'
        | 'COMPENSATION_INCOMPLETE'
        | 'PERMISSION_DENIED'
        | 'EXECUTION_FAILED';
      failureCode?: string;
    };

export interface RollbackExecutionRecorder {
  reserve(params: {
    operationKey: string;
    targetVersionId: string;
    adminId: string;
  }): Promise<FeedRollbackRpcResult>;

  prepare(params: {
    attemptId: string;
    executionToken: string;

    baselineRecordCount: number;
    baselineFeedHash: string;
    baselineFeedContent: string;

    targetRecordCount: number;
    targetFeedHash: string;
    targetFeedContent: string;
  }): Promise<FeedRollbackRpcResult>;

  markStorageWritten(params: {
    attemptId: string;
    executionToken: string;
    feedHash: string;
    recordCount: number;
  }): Promise<FeedRollbackRpcResult>;

  finalize(params: {
    attemptId: string;
    executionToken: string;
  }): Promise<FeedRollbackRpcResult>;

  fail(params: {
    attemptId: string;
    executionToken: string;
    failureCode: string;
    compensationFailureCode?: string;
  }): Promise<FeedRollbackRpcResult>;
}

export interface CanonicalFeedStorage {
  download(): Promise<Buffer | null>;
  uploadExact(content: string): Promise<void>;
}

export interface LocalFeedRollbackExecutionDependencies {
  getVersion(
    versionId: string,
  ): Promise<PublicFeedVersionDetail | null>;

  recorder: RollbackExecutionRecorder;

  storage: CanonicalFeedStorage;

  isLocalExecutionAvailable(): boolean;
}

interface ParsedRpc {
  resultCode: string;
  attemptId?: string;
  executionToken?: string;
  historyVersionId?: string;
}

function parseRpc(
  result: FeedRollbackRpcResult,
): ParsedRpc {
  return {
    resultCode: String(result.resultCode),

    attemptId:
      typeof result.attemptId === 'string'
        ? result.attemptId
        : undefined,

    executionToken:
      typeof result.executionToken === 'string'
        ? result.executionToken
        : undefined,

    historyVersionId:
      typeof result.historyVersionId === 'string'
        ? result.historyVersionId
        : undefined,
  };
}

function normalizePersistenceFailure(
  resultCode: string,
): RollbackExecutionResult {
  if (resultCode === 'PERMISSION_DENIED') {
    return {
      resultCode: 'PERMISSION_DENIED',
    };
  }

  if (resultCode === 'PUBLICATION_IN_PROGRESS') {
    return {
      resultCode: 'PUBLICATION_IN_PROGRESS',
    };
  }

  if (resultCode === 'ROLLBACK_IN_PROGRESS') {
    return {
      resultCode: 'ROLLBACK_IN_PROGRESS',
    };
  }

  if (resultCode === 'COMPENSATION_INCOMPLETE') {
    return {
      resultCode: 'COMPENSATION_INCOMPLETE',
    };
  }

  return {
    resultCode: 'EXECUTION_FAILED',
    failureCode: resultCode,
  };
}

function verifyCurrentCanonical(
  content: string,
): {
  content: string;
  feedHash: string;
  recordCount: number;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('CURRENT_FEED_NOT_JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('CURRENT_FEED_NOT_ARRAY');
  }

  const validation = validatePublicFeed(parsed);

  if (!validation.valid) {
    throw new Error(
      'CURRENT_FEED_VALIDATION_FAILED',
    );
  }

  const artifact =
    serializePublicFeedArtifact(parsed);

  if (artifact.content !== content) {
    throw new Error(
      'CURRENT_FEED_NON_CANONICAL',
    );
  }

  return {
    content: artifact.content,
    feedHash: artifact.feedHash,
    recordCount: artifact.recordCount,
  };
}

function newOperationKey(): string {
  return crypto.randomUUID();
}

function normalizeFailureCode(
  error: unknown,
): string {
  if (!(error instanceof Error)) {
    return 'ROLLBACK_EXECUTION_FAILED';
  }

  return error.message
    .replace(/[^A-Z0-9_]/gi, '_')
    .toUpperCase()
    .slice(0, 64);
}

/**
 * Executes a controlled rollback of the canonical public feed.
 *
 * Guarantees:
 * - requires explicit acknowledgement;
 * - Local/disposable only;
 * - verifies historical artifact before reservation;
 * - verifies prepared baseline before execution;
 * - joins publication/removal concurrency through rollback RPCs;
 * - verifies exact bytes after write;
 * - compensates to the original baseline if post-write execution fails;
 * - does not modify project lifecycle state.
 */
export async function executeLocalFeedRollback(
  params: {
    targetVersionId: string;

    actorAdminId: string;

    acknowledgement: string;

    preparedBaselineFeedHash: string;

    operationKey?: string;

    dependencies:
      LocalFeedRollbackExecutionDependencies;
  },
): Promise<RollbackExecutionResult> {
  if (
    params.acknowledgement !==
    ROLLBACK_ACKNOWLEDGEMENT
  ) {
    return {
      resultCode:
        'ACKNOWLEDGEMENT_REQUIRED',
    };
  }

  if (
    !params.dependencies
      .isLocalExecutionAvailable()
  ) {
    return {
      resultCode:
        'LOCAL_EXECUTION_REQUIRED',
    };
  }

  const target =
    await params.dependencies.getVersion(
      params.targetVersionId,
    );

  if (!target) {
    return {
      resultCode:
        'HISTORICAL_VERSION_NOT_FOUND',
    };
  }

  let verifiedTarget;

  try {
    verifiedTarget =
      verifyHistoricalFeedArtifact({
        content: target.artifactContent,
        expectedHash: target.feedHash,
        expectedRecordCount:
          target.recordCount,
      });
  } catch (error) {
    return {
      resultCode:
        'HISTORICAL_ARTIFACT_INVALID',

      failureCode:
        error instanceof
        FeedArtifactVerificationError
          ? error.code
          : 'ARTIFACT_INVALID',
    };
  }

  const baselineBuffer =
    await params.dependencies.storage.download();

  if (!baselineBuffer) {
    return {
      resultCode:
        'CURRENT_FEED_MISSING',
    };
  }

  let baseline;

  try {
    baseline = verifyCurrentCanonical(
      baselineBuffer.toString('utf8'),
    );
  } catch (error) {
    return {
      resultCode:
        'CURRENT_FEED_INVALID',

      failureCode:
        error instanceof Error
          ? error.message
          : 'CURRENT_FEED_INVALID',
    };
  }

  if (
    baseline.feedHash !==
    params.preparedBaselineFeedHash
  ) {
    return {
      resultCode:
        'STALE_PREPARATION',
    };
  }

  const operationKey =
    params.operationKey ??
    newOperationKey();

  const reserveResult = parseRpc(
    await params.dependencies.recorder.reserve({
      operationKey,

      targetVersionId:
        params.targetVersionId,

      adminId:
        params.actorAdminId,
    }),
  );

  if (
    reserveResult.resultCode ===
    'ALREADY_COMPLETED'
  ) {
    if (!reserveResult.attemptId) {
      return {
        resultCode:
          'EXECUTION_FAILED',

        failureCode:
          'INVALID_ALREADY_COMPLETED_RESPONSE',
      };
    }

    return {
      resultCode:
        'ALREADY_COMPLETED',

      attemptId:
        reserveResult.attemptId,

      historyVersionId:
        reserveResult.historyVersionId,
    };
  }

  if (
    reserveResult.resultCode !==
    'ATTEMPT_RESERVED'
  ) {
    return normalizePersistenceFailure(
      reserveResult.resultCode,
    );
  }

  if (
    !reserveResult.attemptId ||
    !reserveResult.executionToken
  ) {
    return {
      resultCode:
        'EXECUTION_FAILED',

      failureCode:
        'INVALID_RESERVATION_RESPONSE',
    };
  }

  const attemptId =
    reserveResult.attemptId;

  const executionToken =
    reserveResult.executionToken;

  const prepared = parseRpc(
    await params.dependencies.recorder.prepare({
      attemptId,
      executionToken,

      baselineRecordCount:
        baseline.recordCount,

      baselineFeedHash:
        baseline.feedHash,

      baselineFeedContent:
        baseline.content,

      targetRecordCount:
        verifiedTarget.recordCount,

      targetFeedHash:
        verifiedTarget.feedHash,

      targetFeedContent:
        verifiedTarget.content,
    }),
  );

  if (
    prepared.resultCode !==
    'ARTIFACT_BOUND'
  ) {
    await params.dependencies.recorder.fail({
      attemptId,
      executionToken,
      failureCode:
        'ROLLBACK_PREPARE_BIND_FAILED',
    });

    return normalizePersistenceFailure(
      prepared.resultCode,
    );
  }

  // Re-read canonical baseline after durable reservation exists.
  const immediateBaselineBuffer =
    await params.dependencies.storage.download();

  if (!immediateBaselineBuffer) {
    await params.dependencies.recorder.fail({
      attemptId,
      executionToken,
      failureCode:
        'CURRENT_FEED_MISSING_BEFORE_WRITE',
    });

    return {
      resultCode:
        'CURRENT_FEED_MISSING',
    };
  }

  let immediateBaseline;

  try {
    immediateBaseline =
      verifyCurrentCanonical(
        immediateBaselineBuffer.toString(
          'utf8',
        ),
      );
  } catch (error) {
    await params.dependencies.recorder.fail({
      attemptId,
      executionToken,

      failureCode:
        'CURRENT_FEED_INVALID_BEFORE_WRITE',
    });

    return {
      resultCode:
        'CURRENT_FEED_INVALID',

      failureCode:
        error instanceof Error
          ? error.message
          : undefined,
    };
  }

  if (
    immediateBaseline.feedHash !==
      baseline.feedHash ||
    immediateBaseline.content !==
      baseline.content
  ) {
    await params.dependencies.recorder.fail({
      attemptId,
      executionToken,
      failureCode:
        'STALE_PREPARATION',
    });

    return {
      resultCode:
        'STALE_PREPARATION',
    };
  }

  let canonicalWriteOccurred = false;

  try {
    await params.dependencies.storage.uploadExact(
      verifiedTarget.content,
    );

    canonicalWriteOccurred = true;

    const writtenBuffer =
      await params.dependencies.storage.download();

    if (!writtenBuffer) {
      throw new Error(
        'ROLLBACK_WRITE_READBACK_MISSING',
      );
    }

    const writtenContent =
      writtenBuffer.toString('utf8');

    const writtenArtifact =
      verifyHistoricalFeedArtifact({
        content: writtenContent,

        expectedHash:
          verifiedTarget.feedHash,

        expectedRecordCount:
          verifiedTarget.recordCount,
      });

    if (
      writtenArtifact.content !==
      verifiedTarget.content
    ) {
      throw new Error(
        'ROLLBACK_WRITTEN_BYTES_MISMATCH',
      );
    }

    const marked = parseRpc(
      await params.dependencies.recorder
        .markStorageWritten({
          attemptId,
          executionToken,

          feedHash:
            writtenArtifact.feedHash,

          recordCount:
            writtenArtifact.recordCount,
        }),
    );

    if (
      marked.resultCode !==
      'STORAGE_WRITTEN'
    ) {
      throw new Error(
        `ROLLBACK_STORAGE_MARK_FAILED_${marked.resultCode}`,
      );
    }

    const finalized = parseRpc(
      await params.dependencies.recorder
        .finalize({
          attemptId,
          executionToken,
        }),
    );

    if (
      finalized.resultCode ===
      'ALREADY_COMPLETED'
    ) {
      return {
        resultCode:
          'ALREADY_COMPLETED',

        attemptId,

        historyVersionId:
          finalized.historyVersionId,
      };
    }

    if (
      finalized.resultCode !==
        'COMPLETED' ||
      !finalized.historyVersionId
    ) {
      throw new Error(
        `ROLLBACK_FINALIZE_FAILED_${finalized.resultCode}`,
      );
    }

    return {
      resultCode: 'COMPLETED',

      attemptId,

      historyVersionId:
        finalized.historyVersionId,
    };
  } catch (error) {
    const failureCode =
      normalizeFailureCode(error);

    if (!canonicalWriteOccurred) {
      await params.dependencies.recorder.fail({
        attemptId,
        executionToken,
        failureCode,
      });

      return {
        resultCode:
          'EXECUTION_FAILED',

        failureCode,
      };
    }

    // Canonical write occurred but operation did not converge.
    // Restore the exact baseline before declaring failure.
    try {
      await params.dependencies.storage.uploadExact(
        baseline.content,
      );

      const compensated =
        await params.dependencies.storage.download();

      if (!compensated) {
        throw new Error(
          'COMPENSATION_READBACK_MISSING',
        );
      }

      const compensatedContent =
        compensated.toString('utf8');

      if (
        compensatedContent !==
        baseline.content
      ) {
        throw new Error(
          'COMPENSATION_VERIFICATION_FAILED',
        );
      }

      const compensatedArtifact =
        verifyCurrentCanonical(
          compensatedContent,
        );

      if (
        compensatedArtifact.feedHash !==
        baseline.feedHash
      ) {
        throw new Error(
          'COMPENSATION_HASH_MISMATCH',
        );
      }

      await params.dependencies.recorder.fail({
        attemptId,
        executionToken,
        failureCode,
      });

      return {
        resultCode:
          'EXECUTION_FAILED',

        failureCode,
      };
    } catch {
      await params.dependencies.recorder.fail({
        attemptId,
        executionToken,

        failureCode,

        compensationFailureCode:
          'CANONICAL_FEED_COMPENSATION_FAILED',
      });

      return {
        resultCode:
          'COMPENSATION_INCOMPLETE',

        failureCode,
      };
    }
  }
}