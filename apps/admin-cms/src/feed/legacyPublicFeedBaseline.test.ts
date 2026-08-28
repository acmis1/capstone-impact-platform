import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { PublicFeedRecord } from '../domain/publicFeed';
import { createMockProject } from '../test/projectFixtures';
import { toPublicFeedRecord } from './compilePublicFeed';
import { createPublicFeedArtifact, verifyPublicFeedArtifact } from './publicFeedArtifact';
import {
  LegacyPublicFeedBaselineError,
  verifyLegacyPublicFeedBaseline,
} from './legacyPublicFeedBaseline';

type MutableLegacyRecord = Omit<PublicFeedRecord, 'snapshotMedia'> & {
  snapshotMedia: Array<{ url: string; altText: string; galleryPosition?: number }>;
};

function currentRecord(publicId: string, suffix: string): PublicFeedRecord {
  const first = `https://example.com/${suffix}/snapshot-1.png`;
  const second = `https://example.com/${suffix}/snapshot-2.png`;
  return toPublicFeedRecord(createMockProject({
    publicId,
    status: 'published',
    title: `Project ${suffix}`,
    snapshots: [first, second],
    snapshotMedia: [
      { url: first, altText: `${suffix} first snapshot.`, galleryPosition: 1 },
      { url: second, altText: `${suffix} second snapshot.`, galleryPosition: 2 },
    ],
  }));
}

const current = createPublicFeedArtifact([
  currentRecord('project-a', 'a'),
  currentRecord('project-b', 'b'),
]);

function legacyFixture(): MutableLegacyRecord[] {
  return current.feed.map((record) => ({
    ...structuredClone(record),
    snapshotMedia: record.snapshotMedia.map(({ url, altText }) => ({ url, altText })),
  }));
}

function legacyContent(feed = legacyFixture()): string {
  return JSON.stringify(feed, null, 2);
}

function expectMismatch(change: (feed: MutableLegacyRecord[]) => void): void {
  const feed = legacyFixture();
  change(feed);
  expect(() => verifyLegacyPublicFeedBaseline(legacyContent(feed), current)).toThrowError(
    expect.objectContaining<Partial<LegacyPublicFeedBaselineError>>({
      code: 'LEGACY_BASELINE_MISMATCH',
    }),
  );
}

describe('pre-gallery public-feed baseline adoption proof', () => {
  it('accepts only the exact pre-gallery bytes and upgrades to the exact current projection', () => {
    const content = legacyContent();
    const result = verifyLegacyPublicFeedBaseline(content, current);

    expect(result.content).toBe(content);
    expect(result.feedHash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(result.recordCount).toBe(2);
    expect(result.upgradedArtifact.content).toBe(current.content);
    expect(result.upgradedArtifact.bytes.equals(current.bytes)).toBe(true);
    expect(result.upgradedArtifact.feed[0].snapshotMedia.map(({ galleryPosition }) => galleryPosition))
      .toEqual([1, 2]);
    expect(() => verifyPublicFeedArtifact(content)).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_CONTRACT_INVALID' }),
    );
  });

  it.each([
    ['public ID drift', (feed: MutableLegacyRecord[]) => { feed[0].publicId = 'other-project'; }],
    ['member removal', (feed: MutableLegacyRecord[]) => { feed.pop(); }],
    ['member reorder', (feed: MutableLegacyRecord[]) => { feed.reverse(); }],
    ['scalar metadata drift', (feed: MutableLegacyRecord[]) => { feed[0].title = 'Changed title'; }],
    ['taxonomy drift', (feed: MutableLegacyRecord[]) => { feed[0].disciplines = ['Changed taxonomy']; }],
    ['team-member drift', (feed: MutableLegacyRecord[]) => { feed[0].teamMembers = ['Changed member']; }],
    ['external-link drift', (feed: MutableLegacyRecord[]) => { feed[0].externalLinks![0].url = 'https://example.com/changed'; }],
    ['layout drift', (feed: MutableLegacyRecord[]) => { feed[0].layoutConfig.sectionOrder.reverse(); }],
    ['poster drift', (feed: MutableLegacyRecord[]) => { feed[0].poster = 'https://example.com/changed-poster.png'; }],
    ['PDF drift', (feed: MutableLegacyRecord[]) => { feed[0].posterPdf = 'https://example.com/changed-poster.pdf'; }],
    ['wrong alt text', (feed: MutableLegacyRecord[]) => { feed[0].snapshotMedia[0].altText = 'Wrong image description.'; }],
    ['wrong snapshot URL', (feed: MutableLegacyRecord[]) => { feed[0].snapshotMedia[0].url = 'https://example.com/wrong.png'; }],
    ['duplicate snapshot URL', (feed: MutableLegacyRecord[]) => {
      feed[0].snapshots[1] = feed[0].snapshots[0];
      feed[0].snapshotMedia[1].url = feed[0].snapshotMedia[0].url;
    }],
    ['added snapshot', (feed: MutableLegacyRecord[]) => {
      feed[0].snapshots.push('https://example.com/a/added.png');
      feed[0].snapshotMedia.push({ url: 'https://example.com/a/added.png', altText: 'Added.' });
    }],
    ['removed snapshot', (feed: MutableLegacyRecord[]) => {
      feed[0].snapshots.pop();
      feed[0].snapshotMedia.pop();
    }],
    ['gallery reorder', (feed: MutableLegacyRecord[]) => { feed[0].snapshotMedia.reverse(); }],
    ['gallery-position contradiction', (feed: MutableLegacyRecord[]) => { feed[0].snapshotMedia[0].galleryPosition = 2; }],
    ['unknown legacy field', (feed: MutableLegacyRecord[]) => {
      (feed[0] as unknown as Record<string, unknown>).legacyCompatibility = true;
    }],
    ['cross-project media pairing', (feed: MutableLegacyRecord[]) => {
      [feed[0].snapshots, feed[1].snapshots] = [feed[1].snapshots, feed[0].snapshots];
      [feed[0].snapshotMedia, feed[1].snapshotMedia] = [feed[1].snapshotMedia, feed[0].snapshotMedia];
    }],
  ] as const)('rejects %s', (_label, change) => {
    expectMismatch(change);
  });

  it.each([
    ['malformed JSON', '{', 'LEGACY_BASELINE_MALFORMED_JSON'],
    ['wrong top-level shape', '{}', 'LEGACY_BASELINE_WRONG_SHAPE'],
    ['current-contract bytes', current.content, 'LEGACY_BASELINE_MISMATCH'],
  ])('rejects %s', (_label, content, code) => {
    expect(() => verifyLegacyPublicFeedBaseline(content, current)).toThrowError(
      expect.objectContaining<Partial<LegacyPublicFeedBaselineError>>({ code }),
    );
  });

  it('does not enable adoption when the current projection has no gallery positions to add', () => {
    const noGallery = createPublicFeedArtifact([
      toPublicFeedRecord(createMockProject({
        publicId: 'no-gallery', status: 'published', snapshots: [], snapshotMedia: [],
      })),
    ]);
    expect(() => verifyLegacyPublicFeedBaseline(noGallery.content, noGallery)).toThrowError(
      expect.objectContaining({ code: 'LEGACY_BASELINE_NOT_APPLICABLE' }),
    );
  });
});
