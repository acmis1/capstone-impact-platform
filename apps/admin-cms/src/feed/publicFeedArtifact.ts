import { createHash } from 'crypto';
import type { PublicFeedRecord } from '../domain/publicFeed';
import { validatePublicFeed } from './validatePublicFeed';

export const MAX_PUBLIC_FEED_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface PublicFeedArtifactMember {
  ordinal: number;
  publicId: string;
  recordHash: string;
}

export interface VerifiedPublicFeedArtifact {
  content: string;
  bytes: Buffer;
  feed: PublicFeedRecord[];
  feedHash: string;
  recordCount: number;
  members: PublicFeedArtifactMember[];
}

export class PublicFeedArtifactError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PublicFeedArtifactError';
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Exact canonical bytes for one membership record. */
export function serializePublicFeedRecord(record: PublicFeedRecord): string {
  return JSON.stringify(record);
}

/** Canonical feed serialization shared by every candidate and historical artifact. */
export function serializeCanonicalPublicFeed(feed: readonly PublicFeedRecord[]): string {
  return JSON.stringify(feed, null, 2);
}

function decodeStrictUtf8(bytes: Buffer): string {
  if (bytes.byteLength > MAX_PUBLIC_FEED_ARTIFACT_BYTES) {
    throw new PublicFeedArtifactError('ARTIFACT_TOO_LARGE');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PublicFeedArtifactError('ARTIFACT_INVALID_UTF8');
  }
}

/**
 * Verifies the exact public artifact boundary without returning its body on failure.
 * Size is checked before decode or JSON parsing, and canonical byte equality is mandatory.
 */
export function verifyPublicFeedArtifact(input: Buffer | Uint8Array | string): VerifiedPublicFeedArtifact {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const content = decodeStrictUtf8(bytes);
  if (content.charCodeAt(0) === 0xfeff || Buffer.from(content, 'utf8').compare(bytes) !== 0) {
    throw new PublicFeedArtifactError('ARTIFACT_NONCANONICAL_UTF8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PublicFeedArtifactError('ARTIFACT_MALFORMED_JSON');
  }
  if (!Array.isArray(parsed)) throw new PublicFeedArtifactError('ARTIFACT_WRONG_SHAPE');

  const validation = validatePublicFeed(parsed);
  if (!validation.valid) throw new PublicFeedArtifactError('ARTIFACT_CONTRACT_INVALID');

  const feed = parsed as PublicFeedRecord[];
  const seen = new Set<string>();
  const members = feed.map((record, ordinal) => {
    if (typeof record.publicId !== 'string' || record.publicId.length === 0 || seen.has(record.publicId)) {
      throw new PublicFeedArtifactError('ARTIFACT_DUPLICATE_PUBLIC_ID');
    }
    seen.add(record.publicId);
    return {
      ordinal,
      publicId: record.publicId,
      recordHash: hashBytes(Buffer.from(serializePublicFeedRecord(record), 'utf8')),
    };
  });

  if (serializeCanonicalPublicFeed(feed) !== content) {
    throw new PublicFeedArtifactError('ARTIFACT_NONCANONICAL_JSON');
  }

  return {
    content,
    bytes,
    feed,
    feedHash: hashBytes(bytes),
    recordCount: feed.length,
    members,
  };
}

export function createPublicFeedArtifact(feed: readonly PublicFeedRecord[]): VerifiedPublicFeedArtifact {
  return verifyPublicFeedArtifact(serializeCanonicalPublicFeed(feed));
}

export function composePublicFeedPublication(
  current: VerifiedPublicFeedArtifact,
  record: PublicFeedRecord,
): VerifiedPublicFeedArtifact {
  if (current.members.some((member) => member.publicId === record.publicId)) {
    throw new PublicFeedArtifactError('PUBLIC_ID_ALREADY_DEPLOYED');
  }
  return createPublicFeedArtifact([...current.feed, record]);
}

export function composePublicFeedRemoval(
  current: VerifiedPublicFeedArtifact,
  publicId: string,
): VerifiedPublicFeedArtifact {
  const matches = current.members.filter((member) => member.publicId === publicId);
  if (matches.length > 1) throw new PublicFeedArtifactError('ARTIFACT_DUPLICATE_PUBLIC_ID');
  if (matches.length === 0) return current;
  return createPublicFeedArtifact(current.feed.filter((record) => record.publicId !== publicId));
}

export interface PublicFeedMemberDiff {
  addedPublicIds: string[];
  removedPublicIds: string[];
  retainedUnchangedPublicIds: string[];
  changedPublicIds: string[];
}

export function diffPublicFeedMembers(
  baseline: VerifiedPublicFeedArtifact,
  target: VerifiedPublicFeedArtifact,
): PublicFeedMemberDiff {
  const before = new Map(baseline.members.map((member) => [member.publicId, member.recordHash]));
  const after = new Map(target.members.map((member) => [member.publicId, member.recordHash]));
  const addedPublicIds = [...after.keys()].filter((publicId) => !before.has(publicId));
  const removedPublicIds = [...before.keys()].filter((publicId) => !after.has(publicId));
  const retained = [...after.keys()].filter((publicId) => before.has(publicId));
  return {
    addedPublicIds,
    removedPublicIds,
    retainedUnchangedPublicIds: retained.filter((publicId) => before.get(publicId) === after.get(publicId)),
    changedPublicIds: retained.filter((publicId) => before.get(publicId) !== after.get(publicId)),
  };
}
