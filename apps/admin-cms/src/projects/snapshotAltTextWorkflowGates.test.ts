import { describe, expect, it } from 'vitest';

import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import {
  computeProjectReviewReadiness,
  type ImportBatchReviewProjectInput,
} from '../import/importBatchReviewReadiness';
import { validateProjectForApproval } from '../validation/projectValidation';
import { createMockProject } from '../test/projectFixtures';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { planPublicationArtifact, type PublicationMediaSource } from './publicationArtifact';

const MAX = ACCESSIBLE_CONTENT_LIMITS.snapshotAltText;
const VALID_ALT = 'Photograph of the deployed sensor enclosure mounted on a mock light pole.';
const MISSING_MESSAGE = 'Snapshot image alt text is missing.';
const TOO_LONG_MESSAGE = 'Snapshot image alt text exceeds the 2,000 character safety limit.';

function readinessInput(
  snapshotAsset: { altText: string | null } | null,
): ImportBatchReviewProjectInput {
  return {
    publicId: '2026-synthetic', title: 'T', summary: 'S', programId: 'p', programName: 'P',
    studyProgram: 'SP', discipline: 'D', groupName: 'G', teamMembers: ['A'],
    posterText: 'Poster full text.', accessibilityText: 'Poster description.',
    snapshots: snapshotAsset ? ['https://example.invalid/snap.png'] : [],
    validationErrors: [], validationWarnings: [], validationFlags: [],
    status: 'draft', disciplineMappingCount: 1, industryMappingCount: 1,
    mediaAssets: [
      { assetType: 'poster_image', isPublicApproved: false, publicUrl: null, altText: null },
      { assetType: 'poster_pdf', isPublicApproved: false, publicUrl: null, altText: null },
      ...(snapshotAsset
        ? [{ assetType: 'snapshot_image', isPublicApproved: false, publicUrl: null, altText: snapshotAsset.altText }]
        : []),
    ],
  };
}

describe('review readiness snapshot alt gate', () => {
  it('stays ready and only warns when the project has no snapshot image', () => {
    const readiness = computeProjectReviewReadiness(readinessInput(null));
    expect(readiness.ready).toBe(true);
    expect(readiness.blockingReasons).not.toContain(MISSING_MESSAGE);
    expect(readiness.warnings).toContain('Snapshot gallery is empty.');
  });

  it('is ready when the snapshot image carries alt text', () => {
    const readiness = computeProjectReviewReadiness(readinessInput({ altText: VALID_ALT }));
    expect(readiness.ready).toBe(true);
    expect(readiness.blockingReasons).toHaveLength(0);
  });

  it('blocks — never merely warns — when the snapshot alt is missing', () => {
    const readiness = computeProjectReviewReadiness(readinessInput({ altText: null }));
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingReasons).toContain(MISSING_MESSAGE);
    expect(readiness.warnings).not.toContain(MISSING_MESSAGE);
  });

  it('blocks when the snapshot alt is only whitespace', () => {
    const readiness = computeProjectReviewReadiness(readinessInput({ altText: '  \n\t ' }));
    expect(readiness.blockingReasons).toContain(MISSING_MESSAGE);
  });

  it('blocks when the snapshot alt exceeds the safety limit, distinctly from absence', () => {
    const readiness = computeProjectReviewReadiness(readinessInput({ altText: 'a'.repeat(MAX + 1) }));
    expect(readiness.blockingReasons).toContain(TOO_LONG_MESSAGE);
    expect(readiness.blockingReasons).not.toContain(MISSING_MESSAGE);
  });

  it('accepts the exact maximum', () => {
    const readiness = computeProjectReviewReadiness(readinessInput({ altText: 'a'.repeat(MAX) }));
    expect(readiness.ready).toBe(true);
  });

  it('leaves the inherited poster requirements untouched', () => {
    const readiness = computeProjectReviewReadiness({
      ...readinessInput({ altText: VALID_ALT }),
      posterText: '',
    });
    expect(readiness.blockingReasons).toContain('Poster full text is missing.');
  });
});

describe('approval validation snapshot alt gate', () => {
  const approvable = createMockProject({ status: 'in_review' });

  it('permits approval when the project has no snapshot media', () => {
    expect(validateProjectForApproval(approvable).valid).toBe(true);
    expect(validateProjectForApproval(approvable, { snapshotMedia: null }).valid).toBe(true);
  });

  it('permits approval when the snapshot media carries alt text', () => {
    expect(validateProjectForApproval(approvable, { snapshotMedia: { altText: VALID_ALT } }).valid).toBe(true);
  });

  it('blocks approval when the snapshot media has no alt text', () => {
    const result = validateProjectForApproval(approvable, { snapshotMedia: { altText: null } });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain(MISSING_MESSAGE);
  });

  it('blocks approval when the snapshot alt exceeds the safety limit', () => {
    const result = validateProjectForApproval(approvable, { snapshotMedia: { altText: 'a'.repeat(MAX + 1) } });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain(TOO_LONG_MESSAGE);
  });

  it('keeps the inherited poster full-text requirement', () => {
    const result = validateProjectForApproval(
      createMockProject({ status: 'in_review', posterText: '' }),
      { snapshotMedia: { altText: VALID_ALT } },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Poster full text is missing.');
  });
});

describe('public feed snapshotMedia contract', () => {
  const published = (overrides: Parameters<typeof createMockProject>[0] = {}) => createMockProject({
    status: 'published',
    snapshots: ['https://cdn.invalid/a.png'],
    snapshotMedia: [{ url: 'https://cdn.invalid/a.png', altText: VALID_ALT }],
    ...overrides,
  });

  it('emits both the compatible URL array and the structured pairing', () => {
    const [record] = compilePublicFeed([published()]);
    expect(record.snapshots).toEqual(['https://cdn.invalid/a.png']);
    expect(record.snapshotMedia).toEqual([{ url: 'https://cdn.invalid/a.png', altText: VALID_ALT }]);
    expect(validatePublicFeed([record]).valid).toBe(true);
  });

  it('emits two empty arrays when a published project has no snapshots', () => {
    const [record] = compilePublicFeed([published({ snapshots: [], snapshotMedia: [] })]);
    expect(record.snapshots).toEqual([]);
    expect(record.snapshotMedia).toEqual([]);
    expect(validatePublicFeed([record]).valid).toBe(true);
  });

  it('rejects a snapshot published with no paired text alternative', () => {
    const [record] = compilePublicFeed([published({ snapshotMedia: [] })]);
    const result = validatePublicFeed([record]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('published without a text alternative');
  });

  it('rejects a pairing whose URL does not match the published snapshot', () => {
    const [record] = compilePublicFeed([published({
      snapshotMedia: [{ url: 'https://cdn.invalid/other.png', altText: VALID_ALT }],
    })]);
    const result = validatePublicFeed([record]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('does not match any remaining entry');
  });

  it('rejects a duplicated pairing that would leave another snapshot undescribed', () => {
    const [record] = compilePublicFeed([published({
      snapshots: ['https://cdn.invalid/a.png', 'https://cdn.invalid/b.png'],
      snapshotMedia: [
        { url: 'https://cdn.invalid/a.png', altText: VALID_ALT },
        { url: 'https://cdn.invalid/a.png', altText: VALID_ALT },
      ],
    })]);
    const result = validatePublicFeed([record]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('published without a text alternative');
  });

  it('rejects a blank or oversized alt text', () => {
    for (const altText of ['', '   ', 'a'.repeat(MAX + 1)]) {
      const [record] = compilePublicFeed([published({
        snapshotMedia: [{ url: 'https://cdn.invalid/a.png', altText }],
      })]);
      expect(validatePublicFeed([record]).valid).toBe(false);
    }
  });

  it('rejects an unknown internal field smuggled into a pairing', () => {
    const [record] = compilePublicFeed([published()]);
    const tampered = {
      ...record,
      snapshotMedia: [{ url: 'https://cdn.invalid/a.png', altText: VALID_ALT, mediaAssetId: 'internal' }],
    };
    const result = validatePublicFeed([tampered]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('unknown field');
  });

  it('still rejects the inherited forbidden internal fields', () => {
    const [record] = compilePublicFeed([published()]);
    const result = validatePublicFeed([{ ...record, internalStaffNotes: 'secret' }]);
    expect(result.valid).toBe(false);
  });
});

describe('publication artifact snapshot alt pairing', () => {
  const PRIVATE_BUCKET = 'project-drafts-private';
  const PUBLIC_BUCKET = 'project-public-assets';
  const target = createMockProject({
    publicId: 'target', status: 'approved', snapshots: [], snapshotMedia: [],
  });

  const source = (id: string, assetType: string, fileName: string, mimeType: string, altTextPublic: string | null): PublicationMediaSource => ({
    id, projectId: 'db-id', assetType, fileName,
    storageBucket: PRIVATE_BUCKET, storagePath: `drafts/target/${assetType}/${fileName}`,
    publicUrl: null, publicStorageBucket: null, publicStoragePath: null,
    mimeType, fileSizeBytes: 100, isPublicApproved: false, altTextPublic,
  });

  const plan = (snapshotAlt: string | null) => planPublicationArtifact({
    projects: [target],
    targetPublicId: 'target',
    mediaAssets: [
      source('11111111-1111-4111-8111-111111111111', 'poster_image', 'poster.png', 'image/png', null),
      source('22222222-2222-4222-8222-222222222222', 'poster_pdf', 'poster.pdf', 'application/pdf', null),
      source('33333333-3333-4333-8333-333333333333', 'snapshot_image', 'snapshot-1.png', 'image/png', snapshotAlt),
    ],
    privateBucket: PRIVATE_BUCKET,
    publicBucket: PUBLIC_BUCKET,
    getPublicUrl: (bucket, path) => `https://cdn.invalid/${bucket}/${path}`,
  });

  it('carries the alt text onto the promotion and pairs it with the promoted public URL', () => {
    const artifact = plan(VALID_ALT);
    const promotion = artifact.mediaPromotions.find((item) => item.assetType === 'snapshot_image');
    expect(promotion?.altTextPublic).toBe(VALID_ALT);

    const record = artifact.feed.find((item) => item.publicId === 'target');
    expect(record?.snapshots).toEqual([promotion?.publicUrl]);
    expect(record?.snapshotMedia).toEqual([{ url: promotion?.publicUrl, altText: VALID_ALT }]);
  });

  it('refuses to plan an artifact around an undescribed snapshot', () => {
    expect(() => plan(null)).toThrow('Publication snapshot media is missing usable alt text.');
    expect(() => plan('   ')).toThrow('Publication snapshot media is missing usable alt text.');
  });

  it('refuses to plan an artifact whose snapshot alt exceeds the safety limit', () => {
    expect(() => plan('a'.repeat(MAX + 1))).toThrow('Publication snapshot media is missing usable alt text.');
  });

  it('never emits a private bucket or draft path alongside the alt text', () => {
    const artifact = plan(VALID_ALT);
    expect(artifact.content).not.toContain(PRIVATE_BUCKET);
    expect(artifact.content).not.toContain('/drafts/');
    expect(artifact.content).toContain(VALID_ALT);
  });
});
