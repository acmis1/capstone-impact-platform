import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { createMockProject } from '../test/projectFixtures';
import { ControlledPublicationDependencies, executeControlledPublication } from './controlledPublicationService';

const ready = { ready: true, resultCode: 'READY' as const, blockers: [], confirmedPreviewId: '11111111-1111-4111-8111-111111111111', confirmedAt: '2026-08-12T00:00:00Z' };
const published = createMockProject({ publicId: 'target', status: 'published' });
const approved = createMockProject({ publicId: 'target', status: 'approved' });

function dependencies(overrides: Partial<ControlledPublicationDependencies> = {}): ControlledPublicationDependencies {
  let feed = Buffer.from('[]', 'utf8');
  return {
    assertDisposableLocalEnvironment: vi.fn(), getReadiness: vi.fn().mockResolvedValue(ready),
    listProjects: vi.fn().mockResolvedValue([approved]), listProjectMedia: vi.fn().mockResolvedValue([]),
    getLatestAttempt: vi.fn().mockResolvedValue(null), getPublicUrl: vi.fn((_bucket, path) => `http://127.0.0.1/public/${path}`),
    beginAttempt: vi.fn(async (plan) => { feed = Buffer.from(plan.content); return { resultCode: 'ATTEMPT_STARTED', attemptId: 'attempt', executionToken: 'token' }; }),
    claimAttempt: vi.fn(), markStorageWritten: vi.fn().mockResolvedValue({ resultCode: 'STORAGE_WRITTEN' }),
    finalizeAttempt: vi.fn(async () => ({ resultCode: 'COMPLETED', snapshotId: 'snapshot', auditRecordId: 'audit' })),
    failAttempt: vi.fn().mockResolvedValue({ resultCode: 'FAILED' }),
    downloadObject: vi.fn(async () => feed), uploadNewObject: vi.fn().mockResolvedValue(true),
    overwriteObject: vi.fn(async (_bucket, _path, content) => { feed = content; }), removeObjects: vi.fn(async () => { feed = Buffer.from('[]'); }),
    ...overrides,
  };
}

const run = (deps: ControlledPublicationDependencies, failurePoint?: Parameters<typeof executeControlledPublication>[0]['failurePoint']) => executeControlledPublication({
  permissions: getPermissionsForRoles(['admin']), publicId: 'target', privateBucket: 'project-drafts-private',
  publicAssetsBucket: 'project-public-assets', publicFeedBucket: 'public-feeds', publicFeedPath: 'capstones-latest.json', dependencies: deps, failurePoint,
});

describe('controlled publication coordinator', () => {
  it('short-circuits reviewer and editor before dependencies execute', async () => {
    for (const role of ['reviewer', 'editor'] as const) {
      const deps = dependencies();
      await expect(executeControlledPublication({ permissions: getPermissionsForRoles([role]), publicId: 'target', privateBucket: 'private', publicAssetsBucket: 'public', publicFeedBucket: 'feeds', publicFeedPath: 'feed.json', dependencies: deps })).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
      expect(deps.getReadiness).not.toHaveBeenCalled(); expect(deps.listProjects).not.toHaveBeenCalled();
    }
  });

  it('fails closed before any write outside a loopback environment', async () => {
    const deps = dependencies({ assertDisposableLocalEnvironment: vi.fn(() => { throw new Error('hosted'); }) });
    await expect(run(deps)).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT' });
    expect(deps.beginAttempt).not.toHaveBeenCalled(); expect(deps.overwriteObject).not.toHaveBeenCalled();
  });

  it('returns exact NOT_READY evidence with zero storage writes', async () => {
    const deps = dependencies({ getReadiness: vi.fn().mockResolvedValue({ ready: false, resultCode: 'PREVIEW_NOT_CONFIRMED', blockers: ['Waiting'] }) });
    await expect(run(deps)).resolves.toEqual({ resultCode: 'NOT_READY', readinessCode: 'PREVIEW_NOT_CONFIRMED', blockers: ['Waiting'] });
    expect(deps.beginAttempt).not.toHaveBeenCalled(); expect(deps.overwriteObject).not.toHaveBeenCalled();
  });

  it('binds the fresh confirmed evidence into begin and returns exact completion evidence', async () => {
    const deps = dependencies({ listProjects: vi.fn().mockResolvedValueOnce([approved]).mockResolvedValueOnce([published]) });
    await expect(run(deps)).resolves.toEqual(expect.objectContaining({ resultCode: 'COMPLETED', attemptId: 'attempt', snapshotId: 'snapshot', auditRecordId: 'audit', recordCount: 1 }));
    expect(deps.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 1 }), '[]', ready.confirmedPreviewId, ready.confirmedAt);
    expect(deps.markStorageWritten).toHaveBeenCalledTimes(1); expect(deps.finalizeAttempt).toHaveBeenCalledTimes(1);
  });

  it.each(['before_media_upload', 'before_feed_upload', 'after_feed_verification', 'before_finalize'] as const)(
    'compensates failure at %s and records a bounded failed attempt', async (failurePoint) => {
      const deps = dependencies();
      const result = await run(deps, failurePoint);
      expect(result.resultCode).toBe('EXECUTION_FAILED');
      expect(deps.failAttempt).toHaveBeenCalledTimes(1);
      if (failurePoint === 'after_feed_verification' || failurePoint === 'before_finalize') expect(deps.overwriteObject).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('stack');
    },
  );

  it('reports compensation failure separately without masking the primary failure', async () => {
    const deps = dependencies();
    await expect(run(deps, 'during_compensation')).resolves.toEqual(expect.objectContaining({ resultCode: 'EXECUTION_FAILED', compensationFailureCode: 'COMPENSATION_FAILED' }));
    expect(deps.failAttempt).toHaveBeenCalledWith('attempt', 'token', expect.any(String), 'COMPENSATION_FAILED');
  });

  it('returns global in-progress and incomplete-compensation boundaries without storage mutation', async () => {
    for (const state of ['prepared', 'compensation_failed'] as const) {
      const deps = dependencies({ getLatestAttempt: vi.fn().mockResolvedValue({ state, leaseExpiresAt: '2099-01-01T00:00:00Z' } as never) });
      expect((await run(deps)).resultCode).toBe(state === 'prepared' ? 'PUBLICATION_IN_PROGRESS' : 'COMPENSATION_INCOMPLETE');
      expect(deps.overwriteObject).not.toHaveBeenCalled();
    }
  });
});
