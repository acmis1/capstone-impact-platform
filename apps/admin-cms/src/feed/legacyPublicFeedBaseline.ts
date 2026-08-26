import { createHash } from 'crypto';
import type { PublicFeedRecord } from '../domain/publicFeed';
import {
  MAX_PUBLIC_FEED_ARTIFACT_BYTES,
  verifyPublicFeedArtifact,
  type VerifiedPublicFeedArtifact,
} from './publicFeedArtifact';

/** The one historical contract shape supported by initial ledger activation. */
type PreGallerySnapshotMedia = Omit<PublicFeedRecord['snapshotMedia'][number], 'galleryPosition'>;

type PreGalleryPublicFeedRecord = Omit<PublicFeedRecord, 'snapshotMedia'> & {
  snapshotMedia: PreGallerySnapshotMedia[];
};

export interface VerifiedLegacyPublicFeedBaseline {
  content: string;
  bytes: Buffer;
  feedHash: string;
  recordCount: number;
  upgradedArtifact: VerifiedPublicFeedArtifact;
}

export class LegacyPublicFeedBaselineError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LegacyPublicFeedBaselineError';
  }
}

function decodeStrictUtf8(bytes: Buffer): string {
  if (bytes.byteLength > MAX_PUBLIC_FEED_ARTIFACT_BYTES) {
    throw new LegacyPublicFeedBaselineError('LEGACY_BASELINE_TOO_LARGE');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new LegacyPublicFeedBaselineError('LEGACY_BASELINE_INVALID_UTF8');
  }
}

/**
 * Proves the exact pre-gallery representation of one authoritative current projection.
 *
 * This is intentionally not a legacy validator. It derives the sole accepted historical byte
 * sequence by deleting only `galleryPosition` from the already-strict current artifact. Exact
 * equality therefore proves every project, scalar, taxonomy, team, media URL/alt pairing, link,
 * layout value, member order, and snapshot order while sourcing the added positions exclusively
 * from the current server-side lifecycle projection.
 */
export function verifyLegacyPublicFeedBaseline(
  input: Buffer | Uint8Array | string,
  currentArtifact: VerifiedPublicFeedArtifact,
): VerifiedLegacyPublicFeedBaseline {
  const current = verifyPublicFeedArtifact(currentArtifact.content);
  if (current.feedHash !== currentArtifact.feedHash
      || current.recordCount !== currentArtifact.recordCount) {
    throw new LegacyPublicFeedBaselineError('LEGACY_UPGRADE_TARGET_INVALID');
  }

  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const content = decodeStrictUtf8(bytes);
  if (content.charCodeAt(0) === 0xfeff || Buffer.from(content, 'utf8').compare(bytes) !== 0) {
    throw new LegacyPublicFeedBaselineError('LEGACY_BASELINE_NONCANONICAL_UTF8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LegacyPublicFeedBaselineError('LEGACY_BASELINE_MALFORMED_JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new LegacyPublicFeedBaselineError('LEGACY_BASELINE_WRONG_SHAPE');
  }

  let removedPositionCount = 0;
  const expectedLegacyFeed: PreGalleryPublicFeedRecord[] = current.feed.map((record) => ({
    ...record,
    snapshotMedia: record.snapshotMedia.map(({ url, altText }) => {
      removedPositionCount += 1;
      return { url, altText };
    }),
  }));

  if (removedPositionCount === 0) {
    throw new LegacyPublicFeedBaselineError('LEGACY_BASELINE_NOT_APPLICABLE');
  }
  if (JSON.stringify(expectedLegacyFeed, null, 2) !== content) {
    throw new LegacyPublicFeedBaselineError('LEGACY_BASELINE_MISMATCH');
  }

  return {
    content,
    bytes,
    feedHash: createHash('sha256').update(bytes).digest('hex'),
    recordCount: parsed.length,
    upgradedArtifact: current,
  };
}
