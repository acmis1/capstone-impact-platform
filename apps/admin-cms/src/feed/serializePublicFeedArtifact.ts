import { createHash } from 'crypto';

/** Canonical bytes shared by dry-run preparation and the guarded storage uploader. */
export function serializePublicFeedArtifact(feed: unknown[]): {
  content: string;
  feedHash: string;
  recordCount: number;
} {
  const content = JSON.stringify(feed, null, 2);
  return {
    content,
    feedHash: createHash('sha256').update(content).digest('hex'),
    recordCount: feed.length,
  };
}
