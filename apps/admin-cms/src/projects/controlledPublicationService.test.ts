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
    listProjects: vi.fn().mockResolvedValue([
      createMockProject({ publicId: 'lifecycle-only', status: 'published' }),
      createMockProject({ publicId: 'target', status: 'approved' }),
    ]),
    listProjectMedia: vi.fn().mockResolvedValue([]),
    getPublicUrl: (_bucket, path) => `https://example.com/${path}`,
    downloadObject: vi.fn().mockResolvedValue(null),
    uploadNewObject: vi.fn().mockResolvedValue(true),
    removeObjects: vi.fn().mockResolvedValue(undefined),
  };
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
    const result = await executeControlledPublication({
      permissions: ['projects.publish'], publicId: 'target', privateBucket: 'private',
      publicAssetsBucket: 'assets', publicFeedBucket: 'feeds', publicFeedPath: 'feed.json', dependencies: dependencies(),
    });
    expect(result).toMatchObject({ resultCode: 'COMPLETED', recordCount: 2 });
  });

  it('surfaces durable recovery-required state without claiming compensation succeeded', async () => {
    mocks.execute.mockResolvedValue({ resultCode: 'RECOVERY_REQUIRED' });
    await expect(executeControlledPublication({
      permissions: ['projects.publish'], publicId: 'target', privateBucket: 'private',
      publicAssetsBucket: 'assets', publicFeedBucket: 'feeds', publicFeedPath: 'feed.json', dependencies: dependencies(),
    })).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
  });
});
