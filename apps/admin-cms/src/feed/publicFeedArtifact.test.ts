import { describe, expect, it } from 'vitest';
import { toPublicFeedRecord } from './compilePublicFeed';
import { createMockProject } from '../test/projectFixtures';
import {
  MAX_PUBLIC_FEED_ARTIFACT_BYTES,
  PublicFeedArtifactError,
  composePublicFeedPublication,
  composePublicFeedRemoval,
  createPublicFeedArtifact,
  diffPublicFeedMembers,
  verifyPublicFeedArtifact,
} from './publicFeedArtifact';

const record = (publicId: string, title = publicId) => toPublicFeedRecord(
  createMockProject({ publicId, title, status: 'published' }),
);

describe('public feed exact artifact contract', () => {
  it('accepts a canonical zero-record feed and hashes exact bytes', () => {
    const artifact = verifyPublicFeedArtifact(Buffer.from('[]'));
    expect(artifact.recordCount).toBe(0);
    expect(artifact.members).toEqual([]);
    expect(artifact.content).toBe('[]');
    expect(artifact.feedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['malformed JSON', Buffer.from('{'), 'ARTIFACT_MALFORMED_JSON'],
    ['wrong top-level shape', Buffer.from('{}'), 'ARTIFACT_WRONG_SHAPE'],
    ['BOM', Buffer.from('\ufeff[]'), 'ARTIFACT_NONCANONICAL_UTF8'],
    ['noncanonical JSON', Buffer.from('[ ]'), 'ARTIFACT_NONCANONICAL_JSON'],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'ARTIFACT_INVALID_UTF8'],
    ['oversized bytes', Buffer.alloc(MAX_PUBLIC_FEED_ARTIFACT_BYTES + 1), 'ARTIFACT_TOO_LARGE'],
  ])('rejects %s before accepting history evidence', (_label, bytes, code) => {
    expect(() => verifyPublicFeedArtifact(bytes)).toThrowError(
      expect.objectContaining<Partial<PublicFeedArtifactError>>({ code }),
    );
  });

  it('rejects duplicate stable public identifiers', () => {
    const duplicated = JSON.stringify([record('same'), record('same')], null, 2);
    expect(() => verifyPublicFeedArtifact(duplicated)).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_DUPLICATE_PUBLIC_ID' }),
    );
  });

  it('publishes from the deployed head without reintroducing unrelated lifecycle rows', () => {
    const head = createPublicFeedArtifact([record('a')]);
    const candidate = composePublicFeedPublication(head, record('c'));
    expect(candidate.feed.map((item) => item.publicId)).toEqual(['a', 'c']);
    expect(() => composePublicFeedPublication(candidate, record('c'))).toThrowError(
      expect.objectContaining({ code: 'PUBLIC_ID_ALREADY_DEPLOYED' }),
    );
  });

  it('removes one exact deployed identifier while preserving order and supports no-byte-change removal', () => {
    const head = createPublicFeedArtifact([record('a'), record('b'), record('c')]);
    expect(composePublicFeedRemoval(head, 'b').feed.map((item) => item.publicId)).toEqual(['a', 'c']);
    expect(composePublicFeedRemoval(head, 'missing')).toBe(head);
  });

  it('distinguishes unchanged membership from same-id content changes', () => {
    const before = createPublicFeedArtifact([record('a'), record('b', 'Before')]);
    const after = createPublicFeedArtifact([record('a'), record('b', 'After'), record('c')]);
    expect(diffPublicFeedMembers(before, after)).toEqual({
      addedPublicIds: ['c'],
      removedPublicIds: [],
      retainedUnchangedPublicIds: ['a'],
      changedPublicIds: ['b'],
    });
  });
});
