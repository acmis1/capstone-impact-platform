import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { PublicationAttemptRecord } from '../repositories/SupabasePublicationExecutionRepositoryCore';
import { createMockProject } from '../test/projectFixtures';
import { ControlledPublicationDependencies, executeControlledPublication } from './controlledPublicationService';
import { PublicationMediaSource } from './publicationArtifact';

const PRIVATE_BUCKET = 'project-drafts-private';
const PUBLIC_ASSETS_BUCKET = 'project-public-assets';
const PUBLIC_FEED_BUCKET = 'public-feeds';
const PUBLIC_FEED_PATH = 'capstones-latest.json';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');

const ready = { ready: true, resultCode: 'READY' as const, blockers: [], confirmedPreviewId: '11111111-1111-4111-8111-111111111111', confirmedAt: '2026-08-12T00:00:00Z' };
const published = createMockProject({ publicId: 'target', status: 'published' });
const approved = createMockProject({ publicId: 'target', status: 'approved' });
const otherPublished = createMockProject({ id: 987654, publicId: 'other', status: 'published' });

const mediaSources: PublicationMediaSource[] = [
  { id: '22222222-2222-4222-8222-222222222222', projectId: 'project', assetType: 'poster_image', fileName: 'poster.png', storageBucket: PRIVATE_BUCKET, storagePath: 'drafts/target/poster_image/poster.png', publicUrl: null, publicStorageBucket: null, publicStoragePath: null, mimeType: 'image/png', fileSizeBytes: PNG.length, isPublicApproved: false },
  { id: '33333333-3333-4333-8333-333333333333', projectId: 'project', assetType: 'poster_pdf', fileName: 'poster.pdf', storageBucket: PRIVATE_BUCKET, storagePath: 'drafts/target/poster_pdf/poster.pdf', publicUrl: null, publicStorageBucket: null, publicStoragePath: null, mimeType: 'application/pdf', fileSizeBytes: PDF.length, isPublicApproved: false },
];
const sourceBytesByPath = new Map<string, Buffer>([
  ['drafts/target/poster_image/poster.png', PNG],
  ['drafts/target/poster_pdf/poster.pdf', PDF],
]);

function completedAttempt(overrides: Partial<PublicationAttemptRecord> = {}): PublicationAttemptRecord {
  const historical = serializePublicFeedArtifact(compilePublicFeed([published]));
  return {
    id: 'attempt', projectId: 'project', publicId: 'target', adminId: 'admin',
    confirmedPreviewId: ready.confirmedPreviewId, confirmedAt: ready.confirmedAt,
    candidateRecordCount: historical.recordCount, candidateFeedHash: historical.feedHash, candidateFeedContent: historical.content,
    feedStorageBucket: PUBLIC_FEED_BUCKET, feedStoragePath: PUBLIC_FEED_PATH, feedPublicUrl: `http://127.0.0.1/public/${PUBLIC_FEED_PATH}`,
    previousFeedExisted: false, previousFeedContent: null, mediaManifest: [], artifactBoundAt: '2026-08-12T00:01:00Z',
    state: 'completed', executionToken: 'token', leaseExpiresAt: '2026-08-12T00:01:00Z',
    publishedSnapshotId: 'snapshot', publishAuditRecordId: 'audit', ...overrides,
  };
}

interface Harness {
  deps: ControlledPublicationDependencies;
  calls: string[];
  publicObjects: Map<string, Buffer>;
  feed(): string | null;
}

function harness(overrides: Partial<ControlledPublicationDependencies> = {}, options: { withMedia?: boolean; preExistingPublic?: Map<string, Buffer> } = {}): Harness {
  const calls: string[] = [];
  const publicObjects = new Map<string, Buffer>(options.preExistingPublic ?? []);
  let feed: Buffer | null = Buffer.from('[]', 'utf8');
  let finalized = false;
  const deps: ControlledPublicationDependencies = {
    assertDisposableLocalEnvironment: vi.fn(),
    getReadiness: vi.fn().mockResolvedValue(ready),
    // Mirrors the real database: the target only becomes published once finalization commits.
    listProjects: vi.fn(async () => { calls.push('listProjects'); return [finalized ? published : approved]; }),
    listProjectMedia: vi.fn(async () => { calls.push('listProjectMedia'); return options.withMedia ? mediaSources : []; }),
    getCompletedAttempt: vi.fn().mockResolvedValue(null),
    getRecoverableAttempt: vi.fn().mockResolvedValue(null),
    getPublishedSnapshot: vi.fn().mockResolvedValue(null),
    getPublishAuditRecord: vi.fn().mockResolvedValue(null),
    getPublicUrl: vi.fn((_bucket, path) => `http://127.0.0.1/public/${path}`),
    reserveAttempt: vi.fn(async () => { calls.push('reserveAttempt'); return { resultCode: 'ATTEMPT_RESERVED', attemptId: 'attempt', executionToken: 'token' }; }),
    prepareAttempt: vi.fn(async () => { calls.push('prepareAttempt'); return { resultCode: 'ARTIFACT_BOUND' }; }),
    claimAttempt: vi.fn(),
    markStorageWritten: vi.fn().mockResolvedValue({ resultCode: 'STORAGE_WRITTEN' }),
    finalizeAttempt: vi.fn(async () => { finalized = true; return { resultCode: 'COMPLETED', snapshotId: 'snapshot', auditRecordId: 'audit' }; }),
    failAttempt: vi.fn().mockResolvedValue({ resultCode: 'FAILED' }),
    downloadObject: vi.fn(async (bucket, path) => {
      if (bucket === PUBLIC_FEED_BUCKET) { calls.push('downloadFeed'); return feed; }
      if (bucket === PRIVATE_BUCKET) return sourceBytesByPath.get(path) ?? null;
      return publicObjects.get(`${bucket}/${path}`) ?? null;
    }),
    uploadNewObject: vi.fn(async (bucket, path, content) => {
      const key = `${bucket}/${path}`;
      if (publicObjects.has(key)) return false;
      publicObjects.set(key, content);
      return true;
    }),
    overwriteObject: vi.fn(async (bucket, path, content) => {
      if (bucket === PUBLIC_FEED_BUCKET) feed = content; else publicObjects.set(`${bucket}/${path}`, content);
    }),
    removeObjects: vi.fn(async (bucket, paths) => {
      if (bucket === PUBLIC_FEED_BUCKET) { feed = null; return; }
      for (const path of paths) publicObjects.delete(`${bucket}/${path}`);
    }),
    ...overrides,
  };
  return { deps, calls, publicObjects, feed: () => (feed === null ? null : feed.toString('utf8')) };
}

const run = (
  deps: ControlledPublicationDependencies,
  failurePoint?: Parameters<typeof executeControlledPublication>[0]['failurePoint'],
  barriers?: Parameters<typeof executeControlledPublication>[0]['barriers'],
) => executeControlledPublication({
  permissions: getPermissionsForRoles(['admin']), publicId: 'target', privateBucket: PRIVATE_BUCKET,
  publicAssetsBucket: PUBLIC_ASSETS_BUCKET, publicFeedBucket: PUBLIC_FEED_BUCKET, publicFeedPath: PUBLIC_FEED_PATH,
  dependencies: deps, failurePoint, barriers,
});

describe('controlled publication coordinator', () => {
  it('short-circuits reviewer and editor before dependencies execute', async () => {
    for (const role of ['reviewer', 'editor'] as const) {
      const { deps } = harness();
      await expect(executeControlledPublication({ permissions: getPermissionsForRoles([role]), publicId: 'target', privateBucket: PRIVATE_BUCKET, publicAssetsBucket: PUBLIC_ASSETS_BUCKET, publicFeedBucket: PUBLIC_FEED_BUCKET, publicFeedPath: PUBLIC_FEED_PATH, dependencies: deps })).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
      expect(deps.getReadiness).not.toHaveBeenCalled(); expect(deps.listProjects).not.toHaveBeenCalled();
    }
  });

  it('fails closed before any write outside a loopback environment', async () => {
    const { deps } = harness({ assertDisposableLocalEnvironment: vi.fn(() => { throw new Error('hosted'); }) });
    await expect(run(deps)).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT' });
    expect(deps.reserveAttempt).not.toHaveBeenCalled(); expect(deps.overwriteObject).not.toHaveBeenCalled();
  });

  it('returns exact NOT_READY evidence with zero storage writes', async () => {
    const { deps } = harness({ getReadiness: vi.fn().mockResolvedValue({ ready: false, resultCode: 'PREVIEW_NOT_CONFIRMED', blockers: ['Waiting'] }) });
    await expect(run(deps)).resolves.toEqual({ resultCode: 'NOT_READY', readinessCode: 'PREVIEW_NOT_CONFIRMED', blockers: ['Waiting'] });
    expect(deps.reserveAttempt).not.toHaveBeenCalled(); expect(deps.overwriteObject).not.toHaveBeenCalled();
  });

  it('reserves global exclusivity before reading any global publication baseline', async () => {
    const { deps, calls } = harness();
    await expect(run(deps)).resolves.toEqual(expect.objectContaining({ resultCode: 'COMPLETED' }));
    expect(calls[0]).toBe('reserveAttempt');
    expect(calls.indexOf('reserveAttempt')).toBeLessThan(calls.indexOf('listProjects'));
    expect(calls.indexOf('reserveAttempt')).toBeLessThan(calls.indexOf('downloadFeed'));
    expect(calls.indexOf('listProjects')).toBeLessThan(calls.indexOf('prepareAttempt'));
    expect(calls.indexOf('downloadFeed')).toBeLessThan(calls.indexOf('prepareAttempt'));
  });

  it('reads zero global baseline when the reservation is refused', async () => {
    for (const [resultCode, expected] of [['PUBLICATION_IN_PROGRESS', 'PUBLICATION_IN_PROGRESS'], ['COMPENSATION_INCOMPLETE', 'COMPENSATION_INCOMPLETE']] as const) {
      const { deps, calls } = harness({ reserveAttempt: vi.fn().mockResolvedValue({ resultCode }) });
      expect((await run(deps)).resultCode).toBe(expected);
      expect(calls).not.toContain('listProjects');
      expect(calls).not.toContain('downloadFeed');
      expect(deps.overwriteObject).not.toHaveBeenCalled();
      expect(deps.uploadNewObject).not.toHaveBeenCalled();
    }
  });

  it('binds the fresh confirmed evidence into the reservation and returns exact completion evidence', async () => {
    const { deps } = harness({ listProjects: vi.fn().mockResolvedValueOnce([approved]).mockResolvedValueOnce([published]) });
    await expect(run(deps)).resolves.toEqual(expect.objectContaining({ resultCode: 'COMPLETED', attemptId: 'attempt', snapshotId: 'snapshot', auditRecordId: 'audit', recordCount: 1 }));
    expect(deps.reserveAttempt).toHaveBeenCalledWith(ready.confirmedPreviewId, ready.confirmedAt);
    expect(deps.prepareAttempt).toHaveBeenCalledWith('attempt', 'token', expect.objectContaining({ recordCount: 1 }), [], '[]');
    expect(deps.markStorageWritten).toHaveBeenCalledTimes(1); expect(deps.finalizeAttempt).toHaveBeenCalledTimes(1);
  });

  it('binds previous-feed evidence observed only after the reservation exists', async () => {
    const { deps, calls } = harness();
    await run(deps);
    const bound = vi.mocked(deps.prepareAttempt).mock.calls[0];
    expect(bound[4]).toBe('[]');
    expect(calls.indexOf('reserveAttempt')).toBeLessThan(calls.indexOf('downloadFeed'));
  });

  it('runs an injected barrier after reservation and before any baseline read', async () => {
    const { deps, calls } = harness();
    await run(deps, undefined, { afterReservation: async () => { calls.push('barrier'); } });
    expect(calls.indexOf('reserveAttempt')).toBeLessThan(calls.indexOf('barrier'));
    expect(calls.indexOf('barrier')).toBeLessThan(calls.indexOf('listProjects'));
    expect(calls.indexOf('barrier')).toBeLessThan(calls.indexOf('downloadFeed'));
  });

  it.each(['after_reservation', 'before_artifact_bind', 'before_media_upload', 'before_feed_upload', 'after_feed_verification', 'before_finalize'] as const)(
    'compensates failure at %s and records a bounded failed attempt', async (failurePoint) => {
      const { deps } = harness();
      const result = await run(deps, failurePoint);
      expect(result.resultCode).toBe('EXECUTION_FAILED');
      expect(deps.failAttempt).toHaveBeenCalledTimes(1);
      if (failurePoint === 'after_feed_verification' || failurePoint === 'before_finalize') expect(deps.overwriteObject).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('stack');
    },
  );

  it('reports compensation failure separately without masking the primary failure', async () => {
    const { deps } = harness();
    await expect(run(deps, 'during_compensation')).resolves.toEqual(expect.objectContaining({ resultCode: 'EXECUTION_FAILED', compensationFailureCode: 'COMPENSATION_FAILED' }));
    expect(deps.failAttempt).toHaveBeenCalledWith('attempt', 'token', expect.any(String), 'COMPENSATION_FAILED');
  });

  it('returns global in-progress for a live recoverable attempt without storage mutation', async () => {
    const { deps } = harness({ getRecoverableAttempt: vi.fn().mockResolvedValue({ id: 'attempt', state: 'reserved', leaseExpiresAt: '2099-01-01T00:00:00Z' } as never) });
    expect((await run(deps)).resultCode).toBe('PUBLICATION_IN_PROGRESS');
    expect(deps.claimAttempt).not.toHaveBeenCalled();
    expect(deps.overwriteObject).not.toHaveBeenCalled();
  });

  it('refuses recovery by an admin who does not own the expired attempt', async () => {
    const { deps, calls } = harness({
      getRecoverableAttempt: vi.fn().mockResolvedValue({ id: 'attempt', state: 'prepared', leaseExpiresAt: '2000-01-01T00:00:00Z' } as never),
      claimAttempt: vi.fn().mockResolvedValue({ resultCode: 'ATTEMPT_OWNER_MISMATCH' }),
    });
    expect((await run(deps)).resultCode).toBe('ATTEMPT_OWNER_MISMATCH');
    expect(calls).not.toContain('listProjects');
    expect(deps.overwriteObject).not.toHaveBeenCalled();
    expect(deps.failAttempt).not.toHaveBeenCalled();
  });

  it('recovers a prepared attempt using its own bound artifact and previous feed, never current state', async () => {
    const bound = serializePublicFeedArtifact(compilePublicFeed([published]));
    const recovered: PublicationAttemptRecord = completedAttempt({
      state: 'prepared', publishedSnapshotId: null, publishAuditRecordId: null,
      previousFeedExisted: true, previousFeedContent: '[]', leaseExpiresAt: '2000-01-01T00:00:00Z',
    });
    const { deps, calls } = harness({
      getRecoverableAttempt: vi.fn().mockResolvedValue(recovered),
      claimAttempt: vi.fn().mockResolvedValue({ resultCode: 'ATTEMPT_CLAIMED', executionToken: 'rotated' }),
      listProjects: vi.fn(async () => { calls.push('listProjects'); return [published]; }),
    });
    await expect(run(deps)).resolves.toEqual(expect.objectContaining({ resultCode: 'COMPLETED', feedHash: bound.feedHash }));
    expect(deps.prepareAttempt).not.toHaveBeenCalled();
    expect(deps.markStorageWritten).toHaveBeenCalledWith('attempt', 'rotated', bound.feedHash, bound.recordCount);
  });

  it('restores the durably bound previous feed, not the pre-reservation feed, on compensation', async () => {
    const priorFeed = serializePublicFeedArtifact(compilePublicFeed([otherPublished])).content;
    const recovered = completedAttempt({
      state: 'prepared', publishedSnapshotId: null, publishAuditRecordId: null,
      previousFeedExisted: true, previousFeedContent: priorFeed, leaseExpiresAt: '2000-01-01T00:00:00Z',
    });
    const { deps, feed } = harness({
      getRecoverableAttempt: vi.fn().mockResolvedValue(recovered),
      claimAttempt: vi.fn().mockResolvedValue({ resultCode: 'ATTEMPT_CLAIMED', executionToken: 'rotated' }),
    });
    expect((await run(deps, 'before_finalize')).resultCode).toBe('EXECUTION_FAILED');
    expect(feed()).toBe(priorFeed);
  });

  it('accepts an already-published target after a later project published, without comparing to the historical artifact', async () => {
    const historical = serializePublicFeedArtifact(compilePublicFeed([published]));
    const current = serializePublicFeedArtifact(compilePublicFeed([published, otherPublished]));
    expect(current.content).not.toBe(historical.content);
    const { deps } = harness({
      getCompletedAttempt: vi.fn().mockResolvedValue(completedAttempt()),
      listProjects: vi.fn().mockResolvedValue([published, otherPublished]),
      downloadObject: vi.fn(async () => Buffer.from(current.content, 'utf8')),
      getPublishedSnapshot: vi.fn().mockResolvedValue({ id: 'snapshot', recordCount: historical.recordCount, feedHash: historical.feedHash, storageBucket: PUBLIC_FEED_BUCKET, storagePath: `${PUBLIC_FEED_BUCKET}/${PUBLIC_FEED_PATH}`, publicUrl: 'http://127.0.0.1/public/capstones-latest.json', createdBy: 'admin' }),
      getPublishAuditRecord: vi.fn().mockResolvedValue({ id: 'audit', projectId: 'project', adminId: 'admin', actionTaken: 'publish', fromStatus: 'approved', toStatus: 'published' }),
    });
    await expect(run(deps)).resolves.toEqual({
      resultCode: 'ALREADY_COMPLETED', attemptId: 'attempt', snapshotId: 'snapshot', auditRecordId: 'audit',
      recordCount: historical.recordCount, feedHash: historical.feedHash,
    });
    expect(deps.reserveAttempt).not.toHaveBeenCalled();
    expect(deps.prepareAttempt).not.toHaveBeenCalled();
    expect(deps.overwriteObject).not.toHaveBeenCalled();
    expect(deps.uploadNewObject).not.toHaveBeenCalled();
  });

  it('rejects an already-published target whose current canonical feed diverged from the database', async () => {
    const { deps } = harness({
      getCompletedAttempt: vi.fn().mockResolvedValue(completedAttempt()),
      listProjects: vi.fn().mockResolvedValue([published, otherPublished]),
      downloadObject: vi.fn(async () => Buffer.from(serializePublicFeedArtifact(compilePublicFeed([published])).content, 'utf8')),
      getPublishedSnapshot: vi.fn().mockResolvedValue({ id: 'snapshot', recordCount: 1, feedHash: serializePublicFeedArtifact(compilePublicFeed([published])).feedHash, storageBucket: PUBLIC_FEED_BUCKET, storagePath: `${PUBLIC_FEED_BUCKET}/${PUBLIC_FEED_PATH}`, publicUrl: 'http://127.0.0.1/public/capstones-latest.json', createdBy: 'admin' }),
      getPublishAuditRecord: vi.fn().mockResolvedValue({ id: 'audit', projectId: 'project', adminId: 'admin', actionTaken: 'publish', fromStatus: 'approved', toStatus: 'published' }),
    });
    await expect(run(deps)).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED' });
    expect(deps.failAttempt).not.toHaveBeenCalled();
  });

  it('rejects an already-published target whose publish audit attribution does not match the attempt owner', async () => {
    const historical = serializePublicFeedArtifact(compilePublicFeed([published]));
    const { deps } = harness({
      getCompletedAttempt: vi.fn().mockResolvedValue(completedAttempt()),
      listProjects: vi.fn().mockResolvedValue([published]),
      downloadObject: vi.fn(async () => Buffer.from(historical.content, 'utf8')),
      getPublishedSnapshot: vi.fn().mockResolvedValue({ id: 'snapshot', recordCount: historical.recordCount, feedHash: historical.feedHash, storageBucket: PUBLIC_FEED_BUCKET, storagePath: `${PUBLIC_FEED_BUCKET}/${PUBLIC_FEED_PATH}`, publicUrl: 'http://127.0.0.1/public/capstones-latest.json', createdBy: 'admin' }),
      getPublishAuditRecord: vi.fn().mockResolvedValue({ id: 'audit', projectId: 'project', adminId: 'other-admin', actionTaken: 'publish', fromStatus: 'approved', toStatus: 'published' }),
    });
    await expect(run(deps)).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'COMPLETED_AUDIT_EVIDENCE_INVALID' });
  });

  it('binds durable public-media ownership and removes only attempt-owned objects on compensation', async () => {
    const { deps, publicObjects } = harness({}, { withMedia: true });
    expect((await run(deps, 'before_finalize')).resultCode).toBe('EXECUTION_FAILED');
    const bound = vi.mocked(deps.prepareAttempt).mock.calls[0][3];
    expect(bound.map((item) => item.preExisting)).toEqual([false, false]);
    expect(bound.every((item) => /^[0-9a-f]{64}$/.test(item.sourceSha256))).toBe(true);
    expect([...publicObjects.keys()]).toEqual([]);
  });

  it('preserves a public object that pre-existed the attempt', async () => {
    const preExisting = new Map([[`${PUBLIC_ASSETS_BUCKET}/published/target/poster_image/poster.png`, PNG]]);
    const { deps, publicObjects } = harness({}, { withMedia: true, preExistingPublic: preExisting });
    expect((await run(deps, 'before_finalize')).resultCode).toBe('EXECUTION_FAILED');
    const bound = vi.mocked(deps.prepareAttempt).mock.calls[0][3];
    expect(bound.find((item) => item.assetType === 'poster_image')?.preExisting).toBe(true);
    expect(bound.find((item) => item.assetType === 'poster_pdf')?.preExisting).toBe(false);
    expect([...publicObjects.keys()]).toEqual([`${PUBLIC_ASSETS_BUCKET}/published/target/poster_image/poster.png`]);
    expect(publicObjects.get(`${PUBLIC_ASSETS_BUCKET}/published/target/poster_image/poster.png`)).toEqual(PNG);
  });

  it('fails closed when a public destination holds different bytes, before binding or writing', async () => {
    const conflicting = new Map([[`${PUBLIC_ASSETS_BUCKET}/published/target/poster_image/poster.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])]]);
    const { deps } = harness({}, { withMedia: true, preExistingPublic: conflicting });
    await expect(run(deps)).resolves.toEqual(expect.objectContaining({ resultCode: 'EXECUTION_FAILED', failureCode: 'MEDIA_STORAGE_CONFLICT' }));
    expect(deps.prepareAttempt).not.toHaveBeenCalled();
    expect(deps.uploadNewObject).not.toHaveBeenCalled();
    expect(deps.overwriteObject).not.toHaveBeenCalled();
  });

  it('rejects recovered execution whose private source bytes no longer match the bound evidence', async () => {
    const recovered = completedAttempt({
      state: 'prepared', publishedSnapshotId: null, publishAuditRecordId: null, leaseExpiresAt: '2000-01-01T00:00:00Z',
      mediaManifest: [{ mediaAssetId: '22222222-2222-4222-8222-222222222222', assetType: 'poster_image', fileName: 'poster.png', mimeType: 'image/png', fileSizeBytes: PNG.length, sourceBucket: PRIVATE_BUCKET, sourcePath: 'drafts/target/poster_image/poster.png', publicBucket: PUBLIC_ASSETS_BUCKET, publicPath: 'published/target/poster_image/poster.png', publicUrl: `http://127.0.0.1/public/published/target/poster_image/poster.png`, preExisting: false, sourceSha256: 'f'.repeat(64) }],
    });
    const { deps } = harness({
      getRecoverableAttempt: vi.fn().mockResolvedValue(recovered),
      claimAttempt: vi.fn().mockResolvedValue({ resultCode: 'ATTEMPT_CLAIMED', executionToken: 'rotated' }),
    });
    await expect(run(deps)).resolves.toEqual(expect.objectContaining({ resultCode: 'EXECUTION_FAILED', failureCode: 'PRIVATE_MEDIA_CHANGED' }));
    expect(deps.uploadNewObject).not.toHaveBeenCalled();
  });

  it('treats a rejected stale execution token as a bounded failure without finalizing', async () => {
    const { deps } = harness({ markStorageWritten: vi.fn().mockResolvedValue({ resultCode: 'ATTEMPT_TOKEN_MISMATCH' }) });
    await expect(run(deps)).resolves.toEqual(expect.objectContaining({ resultCode: 'EXECUTION_FAILED', failureCode: 'STORAGE_EVIDENCE_REJECTED' }));
    expect(deps.finalizeAttempt).not.toHaveBeenCalled();
  });
});
