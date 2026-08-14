import { describe, expect, it } from 'vitest';
import { createMockProject } from '../test/projectFixtures';
import { buildDeterministicPublicMediaPath, planPublicationArtifact, PublicationMediaSource } from './publicationArtifact';

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function source(
  index: number,
  assetType: string,
  fileName: string,
  mimeType: string,
  altTextPublic: string | null = assetType === 'snapshot_image' ? 'Mock snapshot description.' : null,
): PublicationMediaSource {
  return {
    id: UUIDS[index], projectId: 'project-db-id', assetType, fileName,
    storageBucket: 'project-drafts-private', storagePath: `drafts/target/${assetType}/${fileName}`,
    publicUrl: null, publicStorageBucket: null, publicStoragePath: null,
    mimeType, fileSizeBytes: 100, isPublicApproved: false, altTextPublic,
  };
}

const publicUrl = (bucket: string, path: string) => `http://127.0.0.1:54321/storage/v1/object/public/${bucket}/${path}`;

describe('publication artifact and media promotion planning', () => {
  it('derives deterministic traversal-safe public paths', () => {
    expect(buildDeterministicPublicMediaPath('target_2026', 'poster_image', 'poster.png')).toBe('published/target_2026/poster_image/poster.png');
    expect(() => buildDeterministicPublicMediaPath('target/escape', 'poster_image', 'poster.png')).toThrow();
    expect(() => buildDeterministicPublicMediaPath('target', 'poster_image', '../poster.png')).toThrow();
  });

  it('builds the exact final artifact from public URLs while preserving private source bindings', () => {
    const plan = planPublicationArtifact({
      projects: [
        createMockProject({ publicId: 'baseline', status: 'published' }),
        createMockProject({ publicId: 'target', status: 'approved', poster: '', posterPdf: '', snapshots: [] }),
      ],
      targetPublicId: 'target',
      mediaAssets: [
        source(0, 'poster_image', 'poster.png', 'image/png'),
        source(1, 'poster_pdf', 'poster.pdf', 'application/pdf'),
        source(2, 'snapshot_image', 'snapshot-1.png', 'image/png'),
      ],
      privateBucket: 'project-drafts-private', publicBucket: 'project-public-assets', getPublicUrl: publicUrl,
    });
    expect(plan.recordCount).toBe(2);
    expect(plan.mediaPromotions).toHaveLength(3);
    expect(plan.mediaPromotions[0]).toEqual(expect.objectContaining({
      sourceBucket: 'project-drafts-private', publicBucket: 'project-public-assets',
    }));
    expect(plan.content).toContain('/project-public-assets/published/target/poster_image/poster.png');
    expect(plan.content).not.toContain('project-drafts-private');
    expect(plan.content).not.toContain('/drafts/');
  });

  it('supports legitimate legacy public URLs when no private promotion is needed', () => {
    const target = createMockProject({ publicId: 'target', status: 'approved' });
    const plan = planPublicationArtifact({ projects: [target], targetPublicId: 'target', mediaAssets: [], privateBucket: 'project-drafts-private', publicBucket: 'project-public-assets', getPublicUrl: publicUrl });
    expect(plan.recordCount).toBe(1);
    expect(plan.mediaPromotions).toEqual([]);
    expect(plan.content).toContain(target.poster);
  });

  it.each([
    ['duplicate type', [source(0, 'poster_image', 'poster.png', 'image/png'), { ...source(1, 'poster_image', 'poster-2.png', 'image/png') }]],
    ['unsupported type', [source(0, 'video_link', 'video.txt', 'text/plain')]],
    ['unsafe filename', [source(0, 'poster_image', '../poster.png', 'image/png')]],
    ['wrong bucket', [{ ...source(0, 'poster_image', 'poster.png', 'image/png'), storageBucket: 'project-public-assets' }]],
    ['already public contradictory row', [{ ...source(0, 'poster_image', 'poster.png', 'image/png'), isPublicApproved: true }]],
    ['missing required poster PDF', [source(0, 'poster_image', 'poster.png', 'image/png')]],
  ])('fails closed for %s', (_label, mediaAssets) => {
    expect(() => planPublicationArtifact({
      projects: [createMockProject({ publicId: 'target', status: 'approved', poster: '', posterPdf: '' })],
      targetPublicId: 'target', mediaAssets, privateBucket: 'project-drafts-private', publicBucket: 'project-public-assets', getPublicUrl: publicUrl,
    })).toThrow();
  });

  it('rejects legacy private references instead of exposing them', () => {
    expect(() => planPublicationArtifact({
      projects: [createMockProject({ publicId: 'target', status: 'approved', poster: 'http://local/project-drafts-private/drafts/poster.png' })],
      targetPublicId: 'target', mediaAssets: [], privateBucket: 'project-drafts-private', publicBucket: 'project-public-assets', getPublicUrl: publicUrl,
    })).toThrow();
  });
});
