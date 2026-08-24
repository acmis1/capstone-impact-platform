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
  findRemovalCompletionEvidence: mocks.evidence,
}));

import { executeControlledPublicRemoval, type ControlledPublicRemovalDependencies } from './controlledPublicRemovalService';

function dependencies(status: 'published' | 'archived' = 'published'): ControlledPublicRemovalDependencies {
  return {
    supabase: {} as SupabaseClient, adminId: '11111111-1111-4111-8111-111111111111',
    feedBucket: 'feeds', feedPath: 'feed.json', assertDisposableLocalEnvironment: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([createMockProject({ publicId: 'target', status })]),
  };
}

function remove(deps: ControlledPublicRemovalDependencies, archiveReason = 'Archive') {
  return executeControlledPublicRemoval({
    permissions: ['projects.archive'], publicId: 'target', archiveReason, dependencies: deps,
  });
}

/** A head that no longer contains the retried target but belongs to a later, unrelated operation. */
function headWithoutTarget() {
  const artifact = createPublicFeedArtifact([toPublicFeedRecord(createMockProject({ publicId: 'later', status: 'published' }))]);
  return {
    head: {
      currentVersion: {
        id: 'version-later', versionNumber: 4, operationId: 'operation-later',
        publishedSnapshotId: 'snapshot-later', auditRecordId: 'audit-later',
        feedHash: artifact.feedHash, recordCount: artifact.recordCount,
      },
    },
    artifact,
    publicUrl: 'https://example.com/feed.json',
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
    await expect(remove(dependencies())).resolves.toMatchObject({ resultCode: 'COMPLETED', recordCount: 2 });
  });

  it('reports the retried target own removal evidence, not the operation that owns the head', async () => {
    mocks.inspect.mockResolvedValue(headWithoutTarget());
    mocks.evidence.mockResolvedValue({
      operationId: 'operation-target', versionNumber: 3,
      publishedSnapshotId: null, auditRecordId: 'audit-target',
    });

    const result = await remove(dependencies('archived'));
    expect(result).toMatchObject({
      resultCode: 'ALREADY_COMPLETED', attemptId: 'operation-target', auditRecordId: 'audit-target', recordCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('operation-later');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('executes a genuine target-specific removal when no evidence explains the current absence', async () => {
    mocks.inspect.mockResolvedValue(headWithoutTarget());
    mocks.evidence.mockResolvedValue(null);
    mocks.execute.mockResolvedValue({
      resultCode: 'COMPLETED', operationId: 'operation-fresh', versionNumber: null,
      snapshotId: null, auditRecordId: null, feedHash: 'hash', recordCount: 1,
      feedPublicUrl: 'https://example.com/feed.json',
    });

    await expect(remove(dependencies('archived'))).resolves.toMatchObject({
      resultCode: 'COMPLETED', attemptId: 'operation-fresh', auditRecordId: null,
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('passes the archive reason through as durable operation intent', async () => {
    mocks.execute.mockImplementation(async (params) => {
      expect(params.archiveReason).toBe('Withdrawn by the participant');
      return {
        resultCode: 'COMPLETED', operationId: 'operation', versionNumber: 2, snapshotId: null,
        auditRecordId: 'audit', feedHash: 'hash', recordCount: 0, feedPublicUrl: 'https://example.com/feed.json',
      };
    });
    await expect(remove(dependencies(), 'Withdrawn by the participant'))
      .resolves.toMatchObject({ resultCode: 'COMPLETED' });
  });

  it('surfaces durable recovery-required state without claiming compensation succeeded', async () => {
    mocks.execute.mockResolvedValue({ resultCode: 'RECOVERY_REQUIRED' });
    await expect(remove(dependencies())).resolves.toEqual({ resultCode: 'RECOVERY_REQUIRED' });
  });
});
