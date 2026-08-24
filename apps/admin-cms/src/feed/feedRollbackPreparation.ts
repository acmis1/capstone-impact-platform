import type {
  PublicFeedVersionDetail,
} from '../domain/feedHistory';

import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';

import {
  FeedArtifactVerificationError,
  verifyHistoricalFeedArtifact,
} from '../feed/feedArtifactIntegrity';

export interface FeedRollbackPreparationEvidence {
  targetVersionId: string;
  targetVersionNumber: number;

  targetCreatedAt: string;
  targetOperation: string;

  targetRecordCount: number;
  targetFeedHash: string;

  currentRecordCount: number;
  currentFeedHash: string;

  addedPublicIds: string[];
  removedPublicIds: string[];
  retainedPublicIds: string[];

  wouldChangeFeed: boolean;
}

export type PrepareFeedRollbackResult =
  | {
      resultCode: 'READY';
      preparation: FeedRollbackPreparationEvidence;
      baselineContent: string;
      targetContent: string;
    }
  | {
      resultCode:
        | 'HISTORICAL_VERSION_NOT_FOUND'
        | 'HISTORICAL_ARTIFACT_INVALID'
        | 'CURRENT_FEED_MISSING'
        | 'CURRENT_FEED_INVALID';
      failureCode?: string;
    };

export interface FeedRollbackPreparationDependencies {
  getVersion(
    versionId: string,
  ): Promise<PublicFeedVersionDetail | null>;

  downloadCanonicalFeed(): Promise<Buffer | null>;
}

function publicIds(
  records: unknown[],
): string[] {
  return records
    .map((record) => {
      if (
        record &&
        typeof record === 'object' &&
        typeof (
          record as Record<string, unknown>
        ).publicId === 'string'
      ) {
        return String(
          (
            record as Record<string, unknown>
          ).publicId,
        );
      }

      return '';
    })
    .filter(Boolean)
    .sort();
}

function difference(
  left: string[],
  right: string[],
): string[] {
  const rightSet = new Set(right);

  return left.filter(
    (value) => !rightSet.has(value),
  );
}

function intersection(
  left: string[],
  right: string[],
): string[] {
  const rightSet = new Set(right);

  return left.filter((value) =>
    rightSet.has(value),
  );
}

/**
 * Read-only rollback preparation.
 *
 * Important:
 * - does not reserve execution ownership;
 * - does not call rollback mutation RPCs;
 * - does not write storage;
 * - does not update history;
 * - does not change project lifecycle state.
 */
export async function prepareFeedRollback(
  params: {
    targetVersionId: string;
    dependencies: FeedRollbackPreparationDependencies;
  },
): Promise<PrepareFeedRollbackResult> {
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

  const currentBuffer =
    await params.dependencies.downloadCanonicalFeed();

  if (!currentBuffer) {
    return {
      resultCode: 'CURRENT_FEED_MISSING',
    };
  }

  const currentContent =
    currentBuffer.toString('utf8');

  let currentParsed: unknown;

  try {
    currentParsed = JSON.parse(currentContent);
  } catch {
    return {
      resultCode: 'CURRENT_FEED_INVALID',
      failureCode: 'CURRENT_FEED_NOT_JSON',
    };
  }

  if (!Array.isArray(currentParsed)) {
    return {
      resultCode: 'CURRENT_FEED_INVALID',
      failureCode:
        'CURRENT_FEED_NOT_ARRAY',
    };
  }

  let currentArtifact;

  try {
    currentArtifact =
      serializePublicFeedArtifact(
        currentParsed,
      );
  } catch {
    return {
      resultCode: 'CURRENT_FEED_INVALID',
      failureCode:
        'CURRENT_FEED_SERIALIZATION_FAILED',
    };
  }

  // Canonical feed should already be in the canonical serializer
  // representation. If bytes differ, do not prepare rollback
  // against an ambiguous baseline.
  if (
    currentArtifact.content !==
    currentContent
  ) {
    return {
      resultCode: 'CURRENT_FEED_INVALID',
      failureCode:
        'CURRENT_FEED_NON_CANONICAL',
    };
  }

  const currentIds = publicIds(
    currentParsed,
  );

  const targetIds = publicIds(
    verifiedTarget.records,
  );

  const addedPublicIds = difference(
    targetIds,
    currentIds,
  );

  const removedPublicIds = difference(
    currentIds,
    targetIds,
  );

  const retainedPublicIds = intersection(
    currentIds,
    targetIds,
  );

  return {
    resultCode: 'READY',

    baselineContent:
      currentArtifact.content,

    targetContent:
      verifiedTarget.content,

    preparation: {
      targetVersionId: target.id,
      targetVersionNumber:
        target.versionNumber,

      targetCreatedAt:
        target.createdAt,

      targetOperation:
        target.operationType,

      targetRecordCount:
        verifiedTarget.recordCount,

      targetFeedHash:
        verifiedTarget.feedHash,

      currentRecordCount:
        currentArtifact.recordCount,

      currentFeedHash:
        currentArtifact.feedHash,

      addedPublicIds,
      removedPublicIds,
      retainedPublicIds,

      wouldChangeFeed:
        currentArtifact.feedHash !==
        verifiedTarget.feedHash,
    },
  };
}