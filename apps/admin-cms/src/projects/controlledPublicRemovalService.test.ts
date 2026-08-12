import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProject } from '../test/projectFixtures';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { ControlledPublicRemovalDependencies, executeControlledPublicRemoval } from './controlledPublicRemovalService';

const published = createMockProject({ publicId: 'target', status: 'published', pendingRemovalFromPublic: false });
const current = serializePublicFeedArtifact(compilePublicFeed([published]));
function harness(overrides: Partial<ControlledPublicRemovalDependencies> = {}) {
  let stored: Buffer<ArrayBufferLike> = Buffer.from(current.content);
  const deps: ControlledPublicRemovalDependencies = {
    assertDisposableLocalEnvironment: vi.fn(), listProjects: vi.fn().mockResolvedValue([published]), getCompletedAttempt: vi.fn().mockResolvedValue(null),
    getRecoverableAttempt: vi.fn().mockResolvedValue(null), getArchiveAuditRecord: vi.fn(),
    reserveAttempt: vi.fn().mockResolvedValue({ resultCode: 'ATTEMPT_RESERVED', attemptId: 'attempt', executionToken: 'token' }),
    prepareAttempt: vi.fn().mockResolvedValue({ resultCode: 'ARTIFACT_BOUND' }), claimAttempt: vi.fn(),
    markStorageWritten: vi.fn().mockResolvedValue({ resultCode: 'STORAGE_WRITTEN' }),
    finalizeAttempt: vi.fn().mockImplementation(async () => { (deps.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...published, status: 'archived', archivedAt: '2026-08-12T00:00:00Z', archivedFromStatus: 'published', archiveReason: 'Reason', pendingRemovalFromPublic: true }]); return { resultCode: 'COMPLETED', auditRecordId: 'audit' }; }),
    failAttempt: vi.fn().mockResolvedValue({ resultCode: 'FAILED' }), downloadFeed: vi.fn(async () => stored), overwriteFeed: vi.fn(async (content: Buffer) => { stored = content; }), ...overrides,
  };
  return deps;
}
const run = (deps: ControlledPublicRemovalDependencies, extra = {}) => executeControlledPublicRemoval({ permissions: ['projects.archive'], publicId: 'target', archiveReason: 'Reason', dependencies: deps, ...extra });

describe('executeControlledPublicRemoval', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reserves before observing projects or feed and completes a zero-record candidate', async () => {
    const deps = harness(); const calls: string[] = [];
    (deps.reserveAttempt as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push('reserve'); return { resultCode: 'ATTEMPT_RESERVED', attemptId: 'attempt', executionToken: 'token' }; });
    (deps.listProjects as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push('projects'); return [published]; });
    (deps.downloadFeed as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push('feed'); return Buffer.from(calls.includes('write') ? '[]' : current.content); });
    (deps.overwriteFeed as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push('write'); });
    (deps.finalizeAttempt as ReturnType<typeof vi.fn>).mockImplementation(async () => { (deps.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...published, status: 'archived' }]); return { resultCode: 'COMPLETED', auditRecordId: 'audit' }; });
    const result = await run(deps); expect(result).toMatchObject({ resultCode: 'COMPLETED', recordCount: 0 }); expect(calls.indexOf('reserve')).toBeLessThan(calls.indexOf('projects')); expect(calls.indexOf('reserve')).toBeLessThan(calls.indexOf('feed'));
  });
  it('denies missing permission and non-local execution before reservation', async () => { const deps = harness(); await expect(executeControlledPublicRemoval({ permissions: [], publicId: 'target', archiveReason: 'Reason', dependencies: deps })).resolves.toEqual({ resultCode: 'PERMISSION_DENIED' }); expect(deps.reserveAttempt).not.toHaveBeenCalled(); const hosted = harness({ assertDisposableLocalEnvironment: () => { throw new Error('hosted'); } }); await expect(run(hosted)).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT' }); expect(hosted.reserveAttempt).not.toHaveBeenCalled(); });
  it('fails closed before overwrite when the current DB/feed baseline diverges', async () => { const deps = harness({ downloadFeed: vi.fn().mockResolvedValue(Buffer.from('[]')) }); await expect(run(deps)).resolves.toMatchObject({ resultCode: 'EXECUTION_FAILED', failureCode: 'CURRENT_FEED_DIVERGED' }); expect(deps.overwriteFeed).not.toHaveBeenCalled(); });
  it('passes through global-slot, compensation, owner and state results', async () => { for (const resultCode of ['PUBLICATION_IN_PROGRESS', 'COMPENSATION_INCOMPLETE', 'NOT_PUBLISHED'] as const) { const deps = harness({ reserveAttempt: vi.fn().mockResolvedValue({ resultCode }) }); await expect(run(deps)).resolves.toEqual({ resultCode }); } });
  it('compensates exact previous bytes after finalization failure', async () => { let stored: Buffer<ArrayBufferLike> = Buffer.from(current.content); const deps = harness({ overwriteFeed: vi.fn(async (content: Buffer) => { stored = content; }), downloadFeed: vi.fn(async () => stored), finalizeAttempt: vi.fn().mockResolvedValue({ resultCode: 'INVALID_ATTEMPT_STATE' }) }); await expect(run(deps)).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'FINALIZATION_FAILED' }); expect(stored.toString()).toBe(current.content); expect(deps.failAttempt).toHaveBeenCalledWith('attempt', 'token', 'FINALIZATION_FAILED', undefined); });
  it('reports compensation failure and leaves a blocking attempt', async () => { const deps = harness(); await expect(run(deps, { failurePoint: 'during_compensation' })).resolves.toEqual({ resultCode: 'EXECUTION_FAILED', failureCode: 'POST_STORAGE_FAILURE', compensationFailureCode: 'COMPENSATION_FAILED' }); expect(deps.failAttempt).toHaveBeenCalledWith('attempt', 'token', 'POST_STORAGE_FAILURE', 'COMPENSATION_FAILED'); });
  it('rejects a different reason for recovery', async () => { const deps = harness({ getRecoverableAttempt: vi.fn().mockResolvedValue({ id: 'attempt', publicId: 'target', projectId: 'p', adminId: 'a', archiveReason: 'Original', state: 'prepared', leaseExpiresAt: '2000-01-01', artifactBoundAt: 'x' }) }); await expect(run(deps)).resolves.toEqual({ resultCode: 'ARCHIVE_REASON_MISMATCH' }); expect(deps.claimAttempt).not.toHaveBeenCalled(); });
  it('maps different-owner reclaim without mutation', async () => { const deps = harness({ getRecoverableAttempt: vi.fn().mockResolvedValue({ id: 'attempt', publicId: 'target', projectId: 'p', adminId: 'other', archiveReason: 'Reason', state: 'reserved', leaseExpiresAt: '2000-01-01', artifactBoundAt: null }), claimAttempt: vi.fn().mockResolvedValue({ resultCode: 'ATTEMPT_OWNER_MISMATCH' }) }); await expect(run(deps)).resolves.toEqual({ resultCode: 'ATTEMPT_OWNER_MISMATCH' }); expect(deps.prepareAttempt).not.toHaveBeenCalled(); });
  it('returns idempotent completed evidence against today current feed rather than historical hash', async () => {
    const archived = { ...published, status: 'archived' as const, archivedAt: '2026-08-12T00:00:00Z', archivedFromStatus: 'published', archiveReason: 'Reason', pendingRemovalFromPublic: true };
    const attempt = { id: 'attempt', projectId: 'project-id', publicId: 'target', adminId: 'admin-id', archiveReason: 'Reason', candidateRecordCount: 0, candidateFeedHash: serializePublicFeedArtifact([]).feedHash, candidateFeedContent: '[]', feedStorageBucket: 'feed', feedStoragePath: 'feed.json', feedPublicUrl: 'http://local', previousFeedExisted: true, previousFeedContent: current.content, artifactBoundAt: 'x', state: 'completed' as const, executionToken: 'token', leaseExpiresAt: 'x', archiveAuditRecordId: 'audit' };
    const deps = harness({ getCompletedAttempt: vi.fn().mockResolvedValue(attempt), listProjects: vi.fn().mockResolvedValue([archived]), downloadFeed: vi.fn().mockResolvedValue(Buffer.from('[]')), getArchiveAuditRecord: vi.fn().mockResolvedValue({ id: 'audit', projectId: 'project-id', adminId: 'admin-id', actionTaken: 'archive', fromStatus: 'published', toStatus: 'archived', comments: 'Reason' }) });
    await expect(run(deps)).resolves.toMatchObject({ resultCode: 'ALREADY_COMPLETED', recordCount: 0 }); expect(deps.reserveAttempt).not.toHaveBeenCalled();
  });
});
