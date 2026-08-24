import crypto from 'node:crypto';

import type { PublicFeedRecord } from '../domain/publicFeed';
import { serializePublicFeedArtifact } from './serializePublicFeedArtifact';
import { validatePublicFeed } from './validatePublicFeed';

export interface VerifiedFeedArtifact {
  content: string;
  feedHash: string;
  recordCount: number;
  records: PublicFeedRecord[];
}

export type FeedArtifactVerificationFailureCode =
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_NOT_JSON'
  | 'ARTIFACT_NOT_ARRAY'
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_HASH_MISMATCH'
  | 'ARTIFACT_RECORD_COUNT_MISMATCH'
  | 'ARTIFACT_NON_CANONICAL';

export class FeedArtifactVerificationError extends Error {
  constructor(
    readonly code: FeedArtifactVerificationFailureCode,
  ) {
    super(code);
  }
}

export function sha256Utf8(content: string): string {
  return crypto
    .createHash('sha256')
    .update(content, 'utf8')
    .digest('hex');
}

export function verifyHistoricalFeedArtifact(params: {
  content: string | null | undefined;
  expectedHash: string;
  expectedRecordCount: number;
}): VerifiedFeedArtifact {
  const content = params.content;

  if (typeof content !== 'string') {
    throw new FeedArtifactVerificationError(
      'ARTIFACT_MISSING',
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new FeedArtifactVerificationError(
      'ARTIFACT_NOT_JSON',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new FeedArtifactVerificationError(
      'ARTIFACT_NOT_ARRAY',
    );
  }

  const validation = validatePublicFeed(parsed);

  if (!validation.valid) {
    throw new FeedArtifactVerificationError(
      'ARTIFACT_INVALID',
    );
  }

  if (parsed.length !== params.expectedRecordCount) {
    throw new FeedArtifactVerificationError(
      'ARTIFACT_RECORD_COUNT_MISMATCH',
    );
  }

  const hash = sha256Utf8(content);

  if (hash !== params.expectedHash) {
    throw new FeedArtifactVerificationError(
      'ARTIFACT_HASH_MISMATCH',
    );
  }

  const canonical = serializePublicFeedArtifact(parsed);

  if (
    canonical.content !== content ||
    canonical.feedHash !== params.expectedHash ||
    canonical.recordCount !==
      params.expectedRecordCount
  ) {
    throw new FeedArtifactVerificationError(
      'ARTIFACT_NON_CANONICAL',
    );
  }

  return {
    content,
    feedHash: canonical.feedHash,
    recordCount: canonical.recordCount,
    records: parsed as PublicFeedRecord[],
  };
}