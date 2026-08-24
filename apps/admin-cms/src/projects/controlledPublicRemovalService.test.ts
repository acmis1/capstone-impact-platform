import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockProject } from '../test/projectFixtures';
import { createPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { toPublicFeedRecord } from '../feed/compilePublicFeed';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), inspect: vi.fn() }));
vi.mock('./publicFeedWriterCoordinator', () => ({
  executePublicFeedWriter: mocks.execute,
  inspectPublicFeedHead: mocks.inspect,
}));

import { executeControlledPublicRemoval, type ControlledPublicRemovalDependencies } from './controlledPublicRemovalService';

function dependencies(status: 'published' | 'archived' = 'published'): ControlledPublicRemovalDependencies {
  return {
    supabase: {} as SupabaseClient, adminId: '11111111-1111-4111-8111-111111111111',
    feedBucket: 'feeds', feedPath: 'feed.json', assertDisposableLocalEnvironment: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([createMockProject({ publicId: 'target', status })]),
  };
}

describe('ledger-backed controlled public removal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies callers without archive authority', async () => {
    const deps = dependencies();
    await expect(executeControlledPublicRemoval({
      permissions: ['projects.read'], publicId: 'target', archiveReason: 'Archive', dependencies: deps,
    })).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' });
    expect(deps.listProjects).not.toHaveBeenCalled();
  });

  it('removes only the exact deployed publicId and preserves unrelated ordering', async () => {
    const baseline = createPublicFeedArtifact(['a', 'target', 'b'].map((publicId) =>
      toPublicFeedRecord(createMockProject({ publicId, status: 'published' }))));
    mocks.execute.mockImplementation(async (params) => {
      const prepared = await params.prepareCandidate(baseline);
      expect(prepared.artifact.feed.map((record: { publicId: string }) => record.publicId)).toEqual(['a', 'b']);
      return {
        resultCode: 'COMPLETED', operationId: 'operation', versionNumber: 2,
        snapshotId: null, auditRecordId: 'audit', feedHash: prepared.artifact.feedHash,
        recordCount: prepared.artifact.recordCount, feedPublicUrl: 'https://example.com/feed.json',
      };
    });
    await expect(executeControlledPublicRemoval({
      permissions: ['projects.archive'], publicId: 'target', archiveReason: 'Archive', dependencies: dependencies(),
    })).resolves.toMatchObject({ resultCode: 'COMPLETED', recordCount: 2 });
  });

  it('treats an archived and already-not-deployed project as idempotently complete', async () => {
    const artifact = createPublicFeedArtifact([]);
    mocks.inspect.mockResolvedValue({
      head: { currentVersion: { operationId: 'baseline', auditRecordId: null } },
      artifact, publicUrl: 'https://example.com/feed.json',
    });
    await expect(executeControlledPublicRemoval({
      permissions: ['projects.archive'], publicId: 'target', archiveReason: 'Archive', dependencies: dependencies('archived'),
    })).resolves.toMatchObject({ resultCode: 'ALREADY_COMPLETED', recordCount: 0 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
