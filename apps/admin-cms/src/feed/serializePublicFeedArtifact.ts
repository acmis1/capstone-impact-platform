import type { PublicFeedRecord } from '../domain/publicFeed';
import { createPublicFeedArtifact } from './publicFeedArtifact';

/** Canonical bytes shared by dry-run preparation and the guarded storage uploader. */
export function serializePublicFeedArtifact(feed: unknown[]): {
  content: string;
  feedHash: string;
  recordCount: number;
} {
  const artifact = createPublicFeedArtifact(feed as PublicFeedRecord[]);
  return {
    content: artifact.content,
    feedHash: artifact.feedHash,
    recordCount: artifact.recordCount,
  };
}
