import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockProject } from '../test/projectFixtures';
import { createPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { toPublicFeedRecord } from '../feed/compilePublicFeed';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), inspect: vi.fn(), evidence: vi.fn() }));
vi.mock('./publicFeedWriterCoordinator', () => ({
  executePublicFeedWriter: mocks.execute,
  inspectPublicFeedHead: mocks.inspect,
}));
vi.mock('./publicFeedTargetEvidence', () => ({
  findPublicationCompletionEvidence: mocks.evidence,
}));

import { executeControlledPublication, type ControlledPublicationDependencies } from './controlledPublicationService';

function dependencies(): ControlledPublicationDependencies {
  return {
    supabase: {} as SupabaseClient, adminId: '11111111-1111-4111-8111-111111111111',
    assertExecutionEnvironment: vi.fn(),
    getReadiness: vi.fn().mockResolvedValue({
      resultCode: 'READY', ready: true, blockers: [], warnings: [],
      confirmedPreviewId: '22222222-2222-4222-8222-222222222222',
      confirmedAt: '2026-08-24T00:00:00.000Z',
    }),
    getReconciliationReadiness: vi.fn().mockResolvedValue({
      resultCode: 'READY', ready: true, blockers: [],
      confirmedPreviewId: '22222222-2222-4222-8222-222222222222',
      confirmedAt: '2026-08-24T00:00:00.000Z',
    }),
    listProjects: vi.fn().mockResolvedValue([
      createMockProject({ publicId: 'lifecycle-only', status: 'published' }),
      createMockProject({ publicId: 'target', status: 'approved' }),
    ]),
    listProjectMedia: vi.fn().mockResolvedValue([]),
    getPublicUrl: (_bucket, path) => `https://example.com/${path}`,
    downloadObject: vi.fn().mockResolvedValue(null),
    uploadNewObject: vi.fn().mockResolvedValue(true),
  };
}

function deployedDependencies(): ControlledPublicationDependencies {
  return {
    ...dependencies(),
    listProjects: vi.fn().mockResolvedValue([createMockProject({ publicId: 'target', status: 'published' })]),
  };
}

/** A head that contains the retried target plus a later, unrelated project. */
function headWithTargetAndLaterProject() {
  const artifact = createPublicFeedArtifact(['target', 'later'].map((publicId) =>
    toPublicFeedRecord(createMockProject({ publicId, status: 'published' }))));
  return {
    head: {
      currentVersion: {
        id: 'version-later', versionNumber: 3, operationId: 'operation-later',
        publishedSnapshotId: 'snapshot-later', auditRecordId: 'audit-later',
        feedHash: artifact.feedHash, recordCount: artifact.recordCount,
      },
    },
    artifact,
    publicUrl: 'https://example.com/feed.json',
  };
}

function publish(deps: ControlledPublicationDependencies, overrides: Record<string, unknown> = {}) {
  return executeControlledPublication({
    permissions: ['projects.publish'], publicId: 'target', privateBucket: 'private',
    publicAssetsBucket: 'assets', publicFeedBucket: 'feeds', publicFeedPath: 'feed.json',
    dependencies: deps, ...overrides,
  });
}

describe('ledger-backed controlled publication', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies callers without publication authority before any dependency work', async () => {
    const deps = dependencies();
    await expect(executeControlledPublication({
      permissions: ['projects.read'], publicId: 'target', privateBucket: 'private',
      publicAssetsBucket: 'assets', publicFeedBucket: 'feeds', publicFeedPath: 'feed.json', dependencies: deps,
    })).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(deps.listProjects).not.toHaveBeenCalled();
  });

  it('composes from the deployed head and does not re-add an unrelated lifecycle-published row', async () => {
    const deployed = createPublicFeedArtifact([toPublicFeedRecord(createMockProject({ publicId: 'deployed', status: 'published' }))]);
    mocks.execute.mockImplementation(async (params) => {
      const prepared = await params.prepareCandidate(deployed);
      expect(prepared.artifact.feed.map((record: { publicId: string }) => record.publicId)).toEqual(['deployed', 'target']);
      return {
        resultCode: 'COMPLETED', operationId: 'operation', versionNumber: 2,
        snapshotId: 'snapshot', auditRecordId: 'audit', feedHash: prepared.artifact.feedHash,
        recordCount: prepared.artifact.recordCount, feedPublicUrl: 'https://example.com/feed.json',
      };
    });
    await expect(publish(dependencies())).resolves.toMatchObject({ resultCode: 'COMPLETED', recordCount: 2 });
  });

  it('separates media validation from media promotion across the write-intent boundary', async () => {
    mocks.execute.mockImplementation(async (params) => {
      expect(typeof params.validateBeforeWriteIntent).toBe('function');
      expect(typeof params.afterWriteIntent).toBe('function');
      expect(params).not.toHaveProperty('beforeCanonicalWrite');
      return {
        resultCode: 'COMPLETED', operationId: 'operation', versionNumber: 2,
        snapshotId: 'snapshot', auditRecordId: 'audit', feedHash: 'hash',
        recordCount: 1, feedPublicUrl: 'https://example.com/feed.json',
      };
    });
    await expect(publish(dependencies())).resolves.toMatchObject({ resultCode: 'COMPLETED' });
  });

  it('reports the retried target own completion evidence, not the operation that owns the head', async () => {
    mocks.inspect.mockResolvedValue(headWithTargetAndLaterProject());
    mocks.evidence.mockResolvedValue({
      operationId: 'operation-target', versionNumber: 2,
      publishedSnapshotId: 'snapshot-target', auditRecordId: 'audit-target',
    });

    await expect(publish(deployedDependencies())).resolves.toMatchObject({
      resultCode: 'ALREADY_COMPLETED', attemptId: 'operation-target',
      snapshotId: 'snapshot-target', auditRecordId: 'audit-target', recordCount: 2,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('never borrows a rollback head identifier when the target has no matching evidence', async () => {
    mocks.inspect.mockResolvedValue({
      ...headWithTargetAndLaterProject(),
      head: {
        currentVersion: {
          id: 'version-rollback', versionNumber: 5, operationId: 'operation-rollback',
          publishedSnapshotId: null, auditRecordId: null,
        },
      },
    });
    mocks.evidence.mockResolvedValue(null);

    const result = await publish(deployedDependencies());
    expect(result).toEqual({
      resultCode: 'NOT_READY', readinessCode: 'ALREADY_DEPLOYED_UNVERIFIED',
      blockers: [expect.stringContaining('no publication operation in its own history')],
    });
    expect(JSON.stringify(result)).not.toContain('operation-rollback');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('surfaces durable recovery-required state without claiming compensation succeeded', async () => {
    mocks.execute.mockResolvedValue({ resultCode: 'RECOVERY_REQUIRED' });
    await expect(publish(dependencies())).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
  });

  it('proves deployment reconciliation against its own authority, never the pre-publication gate', async () => {
    const deps = deployedDependencies();
    mocks.inspect.mockResolvedValue({ head: null, artifact: null, publicUrl: 'https://example.com/feed.json' });
    mocks.execute.mockImplementation(async (params) => {
      expect(params.publicationMode).toBe('deployment_reconciliation');
      expect(params.confirmedPreviewId).toBe('22222222-2222-4222-8222-222222222222');
      expect(params.confirmedAt).toBe('2026-08-24T00:00:00.000Z');
      return {
        resultCode: 'COMPLETED', operationId: 'operation', versionNumber: 4,
        snapshotId: 'snapshot', auditRecordId: null, feedHash: 'hash',
        recordCount: 1, feedPublicUrl: 'https://example.com/feed.json',
      };
    });

    await expect(publish(deps, { publicationMode: 'deployment_reconciliation' }))
      .resolves.toMatchObject({ resultCode: 'COMPLETED', auditRecordId: null });

    // The approved-only pre-publication gate must never be consulted for a published target.
    expect(deps.getReadiness).not.toHaveBeenCalled();
    expect(deps.getReconciliationReadiness).toHaveBeenCalledTimes(1);
  });

  it('refuses reconciliation on its own readiness verdict without reaching the canonical writer', async () => {
    const deps = deployedDependencies();
    mocks.inspect.mockResolvedValue({ head: null, artifact: null, publicUrl: 'https://example.com/feed.json' });
    deps.getReconciliationReadiness = vi.fn().mockResolvedValue({
      resultCode: 'MEDIA_SNAPSHOT_STALE', ready: false,
      blockers: ['Project media changed after participant confirmation'],
      confirmedPreviewId: null, confirmedAt: null,
    });

    await expect(publish(deps, { publicationMode: 'deployment_reconciliation' })).resolves.toEqual({
      resultCode: 'NOT_READY', readinessCode: 'MEDIA_SNAPSHOT_STALE',
      blockers: ['Project media changed after participant confirmation'],
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(deps.listProjectMedia).not.toHaveBeenCalled();
    expect(deps.downloadObject).not.toHaveBeenCalled();
    expect(deps.uploadNewObject).not.toHaveBeenCalled();
  });

  it('refuses reconciliation whose readiness returns no exact confirmation evidence', async () => {
    const deps = deployedDependencies();
    mocks.inspect.mockResolvedValue({ head: null, artifact: null, publicUrl: 'https://example.com/feed.json' });
    deps.getReconciliationReadiness = vi.fn().mockResolvedValue({
      resultCode: 'READY', ready: true, blockers: [],
      confirmedPreviewId: null, confirmedAt: null,
    });

    await expect(publish(deps, { publicationMode: 'deployment_reconciliation' })).resolves.toMatchObject({
      resultCode: 'NOT_READY', readinessCode: 'READY',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(deps.uploadNewObject).not.toHaveBeenCalled();
  });

  it('binds the authoritative post-reservation target, never the stale pre-readiness target', async () => {
    const staleA = createMockProject({
      publicId: 'target', status: 'approved',
      title: 'Superseded Representation A', summary: 'Superseded participant summary A.',
    });
    const authoritativeB = createMockProject({
      publicId: 'target', status: 'approved',
      title: 'Authoritative Representation B', summary: 'Current confirmed participant summary B.',
    });

    const deps = dependencies();
    // The pre-readiness read sees A. Before readiness and reservation, a legitimate concurrent
    // workflow replaces the participant-facing representation with B and establishes fresh valid
    // participant confirmation for B.
    deps.listProjects = vi.fn()
      .mockResolvedValueOnce([staleA])
      .mockResolvedValue([authoritativeB]);
    // Readiness therefore returns B's exact confirmation evidence, which is what
    // reserve_public_feed_operation independently re-proves and freezes on the durable operation.
    deps.getReadiness = vi.fn().mockResolvedValue({
      resultCode: 'READY', ready: true, blockers: [], warnings: [],
      confirmedPreviewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      confirmedAt: '2026-08-25T01:02:03.000Z',
    });

    const baseline = createPublicFeedArtifact([
      toPublicFeedRecord(createMockProject({ publicId: 'deployed', status: 'published' })),
    ]);
    let bound: { feed: { publicId: string; title: string; summary: string }[]; content: string } | null = null;
    mocks.execute.mockImplementation(async (params) => {
      // The authority the reservation freezes belongs to B.
      expect(params.confirmedPreviewId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      expect(params.confirmedAt).toBe('2026-08-25T01:02:03.000Z');
      const prepared = await params.prepareCandidate(baseline);
      bound = prepared.artifact;
      return {
        resultCode: 'COMPLETED', operationId: 'operation', versionNumber: 2,
        snapshotId: 'snapshot', auditRecordId: 'audit', feedHash: prepared.artifact.feedHash,
        recordCount: prepared.artifact.recordCount, feedPublicUrl: 'https://example.com/feed.json',
      };
    });

    await expect(publish(deps)).resolves.toMatchObject({ resultCode: 'COMPLETED' });

    const artifact = bound!;
    const target = artifact.feed.find((record) => record.publicId === 'target')!;
    // The bound artifact itself must carry B.
    expect(target.title).toBe('Authoritative Representation B');
    expect(target.summary).toBe('Current confirmed participant summary B.');
    expect(target.title).not.toBe('Superseded Representation A');
    expect(artifact.content).not.toContain('Superseded Representation A');
    expect(artifact.content).not.toContain('Superseded participant summary A.');
    // Still composed from the existing deployment baseline plus the exact target.
    expect(artifact.feed.map((record) => record.publicId)).toEqual(['deployed', 'target']);
  });

  it('binds the authoritative post-reservation target for deployment reconciliation', async () => {
    const staleA = createMockProject({
      publicId: 'target', status: 'published',
      title: 'Superseded Published Representation A', summary: 'Superseded published summary A.',
    });
    const authoritativeB = createMockProject({
      publicId: 'target', status: 'published',
      title: 'Authoritative Published Representation B', summary: 'Current published summary B.',
    });

    const deps = dependencies();
    deps.listProjects = vi.fn()
      .mockResolvedValueOnce([staleA])
      .mockResolvedValue([authoritativeB]);
    deps.getReconciliationReadiness = vi.fn().mockResolvedValue({
      resultCode: 'READY', ready: true, blockers: [],
      confirmedPreviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      confirmedAt: '2026-08-25T04:05:06.000Z',
    });
    mocks.inspect.mockResolvedValue({ head: null, artifact: null, publicUrl: 'https://example.com/feed.json' });

    const baseline = createPublicFeedArtifact([
      toPublicFeedRecord(createMockProject({ publicId: 'deployed', status: 'published' })),
    ]);
    let bound: { feed: { publicId: string; title: string; summary: string }[]; content: string } | null = null;
    mocks.execute.mockImplementation(async (params) => {
      expect(params.publicationMode).toBe('deployment_reconciliation');
      expect(params.confirmedPreviewId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      expect(params.confirmedAt).toBe('2026-08-25T04:05:06.000Z');
      const prepared = await params.prepareCandidate(baseline);
      bound = prepared.artifact;
      return {
        resultCode: 'COMPLETED', operationId: 'operation', versionNumber: 4,
        snapshotId: 'snapshot', auditRecordId: null, feedHash: prepared.artifact.feedHash,
        recordCount: prepared.artifact.recordCount, feedPublicUrl: 'https://example.com/feed.json',
      };
    });

    // Reconciliation changes no lifecycle state, so it still writes no approval record.
    await expect(publish(deps, { publicationMode: 'deployment_reconciliation' }))
      .resolves.toMatchObject({ resultCode: 'COMPLETED', auditRecordId: null });

    const artifact = bound!;
    const target = artifact.feed.find((record) => record.publicId === 'target')!;
    expect(target.title).toBe('Authoritative Published Representation B');
    expect(target.summary).toBe('Current published summary B.');
    expect(target.title).not.toBe('Superseded Published Representation A');
    expect(artifact.content).not.toContain('Superseded Published Representation A');
    expect(artifact.feed.map((record) => record.publicId)).toEqual(['deployed', 'target']);
    // The approved-only pre-publication gate is never consulted for a published target.
    expect(deps.getReadiness).not.toHaveBeenCalled();
    expect(deps.getReconciliationReadiness).toHaveBeenCalledTimes(1);
  });

  it('reports readiness loss without reaching the canonical writer', async () => {
    const deps = dependencies();
    deps.getReadiness = vi.fn().mockResolvedValue({
      resultCode: 'PREVIEW_NOT_CONFIRMED', ready: false, blockers: ['Preview not confirmed'], warnings: [],
      confirmedPreviewId: null, confirmedAt: null,
    });
    await expect(publish(deps)).resolves.toEqual({
      resultCode: 'NOT_READY', readinessCode: 'PREVIEW_NOT_CONFIRMED', blockers: ['Preview not confirmed'],
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
