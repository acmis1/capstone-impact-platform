import { describe, expect, it, vi } from 'vitest';

import type { AssistiveRunStatus } from '../domain/jobContract';
import type { AdminPermission } from '../../auth/authTypes';
import {
  BulkAssistiveExecutionService,
  type BulkAssistiveExecutionGateway,
  type BulkAssistiveProjectRecord,
} from '../index';
import type { StoredAssistiveInspectionRun } from '../domain/inspectionContract';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
type EnqueueMock = ReturnType<typeof vi.fn<(
  projectId: string,
  actorAdminUserId: string,
  expectedInputHash: string,
  expectedProjectPublicId: string,
) => Promise<unknown>>>;

function record(publicId: string, projectId = `${publicId}-db`): BulkAssistiveProjectRecord {
  return { publicId, projectId, title: `Title ${publicId}` };
}

function run(inputHash: string, runStatus: AssistiveRunStatus): StoredAssistiveInspectionRun {
  return {
    runId: RUN_ID,
    projectId: '33333333-3333-4333-8333-333333333333',
    inputHash,
    pipelineVersion: 'assistive-deterministic-checks/v3',
    runStatus,
    jobStatus: runStatus === 'QUEUED' ? 'QUEUED' : 'EXTRACTING',
    attemptCount: runStatus === 'QUEUED' ? 0 : 1,
    failureCode: null,
    cancellationRequested: false,
    createdAt: '2026-09-09T00:00:00.000Z',
    startedAt: null,
    completedAt: runStatus === 'QUEUED' || runStatus === 'RUNNING' ? null : '2026-09-09T00:01:00.000Z',
  };
}

function gateway(overrides: Partial<{
  records: Map<string, BulkAssistiveProjectRecord>;
  inspect: Record<string, { kind: 'VALID'; inputHash: string } | { kind: 'MEDIA_INVALID' } | { kind: 'FAILED' }>;
  runs: Record<string, StoredAssistiveInspectionRun | null>;
  enqueue: EnqueueMock;
}> = {}) {
  const records = overrides.records ?? new Map([
    ['project-a', record('project-a')],
    ['project-b', record('project-b')],
    ['project-c', record('project-c')],
    ['project-e', record('project-e')],
  ]);
  const inspect = overrides.inspect ?? {
    'project-a': { kind: 'VALID' as const, inputHash: HASH_A },
    'project-b': { kind: 'VALID' as const, inputHash: HASH_B },
    'project-c': { kind: 'MEDIA_INVALID' as const },
    'project-e': { kind: 'FAILED' as const },
  };
  const runs = overrides.runs ?? { 'project-b': run(HASH_B, 'RUNNING') };
  const enqueue = overrides.enqueue ?? vi.fn<(
    projectId: string,
    actorAdminUserId: string,
    expectedInputHash: string,
    expectedProjectPublicId: string,
  ) => Promise<unknown>>().mockResolvedValue({
    resultCode: 'ENQUEUED', runId: RUN_ID, status: 'QUEUED',
  });
  const fake: BulkAssistiveExecutionGateway = {
    loadProjects: vi.fn(async (ids: string[]) => new Map<string, BulkAssistiveProjectRecord>(ids.flatMap((id) => {
      const value = records.get(id);
      return value ? [[id, value] as const] : [];
    }))),
    inspectInput: vi.fn(async (projectId: string) => inspect[projectId.replace('-db', '')] ?? { kind: 'FAILED' as const }),
    loadCurrentRun: vi.fn(async (projectId) => runs[projectId.replace('-db', '')] ?? null),
    enqueueProject: (projectId, actorAdminUserId, expectedInputHash, expectedProjectPublicId) => enqueue(
      projectId,
      actorAdminUserId,
      expectedInputHash,
      expectedProjectPublicId,
    ),
  };
  return { fake, enqueue };
}

const ready = { canEnqueue: true, state: 'READY', message: null } as const;
const unavailable = { canEnqueue: false, state: 'TEMPORARILY_UNAVAILABLE', message: 'Worker unavailable.' } as const;

describe('BulkAssistiveExecutionService', () => {
  it('preflights mixed eligibility with bounded, server-derived reasons', async () => {
    const { fake } = gateway();
    const service = new BulkAssistiveExecutionService(fake);

    const result = await service.preflight({
      publicIds: ['project-a', 'project-b', 'project-c', 'missing-project', 'project-e'],
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    });

    expect(result.summary).toEqual({ total: 5, eligible: 1, alreadyActiveOrCurrent: 1, blocked: 2, invalidStale: 1 });
    expect(result.items.map((item) => [item.publicId, item.disposition])).toEqual([
      ['missing-project', 'invalid_stale'],
      ['project-a', 'eligible'],
      ['project-b', 'already_active_or_current'],
      ['project-c', 'blocked'],
      ['project-e', 'blocked'],
    ]);
    expect(result.items.every((item) => item.reasons.length <= 5)).toBe(true);
  });

  it('deduplicates selection and enforces the 50-project request boundary', async () => {
    const { fake } = gateway({ records: new Map([['project-a', record('project-a')]]) });
    const service = new BulkAssistiveExecutionService(fake);
    const duplicate = await service.preflight({
      publicIds: ['project-a', 'project-a'],
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    });
    expect(duplicate.summary.total).toBe(1);
    expect(fake.loadProjects).toHaveBeenCalledWith(['project-a']);

    await expect(service.preflight({
      publicIds: Array.from({ length: 51 }, (_, index) => `project-${index}`),
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    })).rejects.toThrow('out of bounds');
  });

  it('maps repeated requests to ENQUEUED then ALREADY_ACTIVE_OR_CURRENT without duplicate authority', async () => {
    const enqueue = vi.fn<(
      projectId: string,
      actorAdminUserId: string,
      expectedInputHash: string,
      expectedProjectPublicId: string,
    ) => Promise<unknown>>()
      .mockResolvedValueOnce({ resultCode: 'ENQUEUED', runId: RUN_ID, status: 'QUEUED' })
      .mockResolvedValue({ resultCode: 'ALREADY_QUEUED', runId: RUN_ID, status: 'QUEUED' });
    const { fake } = gateway({
      records: new Map([['project-a', record('project-a')]]),
      inspect: { 'project-a': { kind: 'VALID', inputHash: HASH_A } },
      runs: {},
      enqueue,
    });
    const service = new BulkAssistiveExecutionService(fake);
    const input = {
      publicIds: ['project-a'],
      expectedInputHashes: { 'project-a': HASH_A },
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    };

    await expect(service.execute(input)).resolves.toMatchObject({ summary: { enqueued: 1 } });
    await expect(service.execute(input)).resolves.toMatchObject({ summary: { alreadyActiveOrCurrent: 1 } });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('blocks without inspecting or enqueueing when the worker is unavailable', async () => {
    const { fake, enqueue } = gateway();
    const service = new BulkAssistiveExecutionService(fake);
    const result = await service.preflight({
      publicIds: ['project-a', 'project-b'],
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: unavailable,
    });
    expect(result.summary.blocked).toBe(2);
    expect(fake.inspectInput).not.toHaveBeenCalled();
    expect(fake.loadCurrentRun).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['continuous mode', { canEnqueue: true, state: 'READY', message: null }],
    ['on-demand with one launch remaining', { canEnqueue: true, state: 'ON_DEMAND_READY', message: null }],
  ])('queues 50 bounded project jobs in %s without launching a worker per project', async (_label, availability) => {
    const records = new Map(Array.from({ length: 50 }, (_, index) => {
      const id = `project-${String(index).padStart(2, '0')}`;
      return [id, record(id)] as const;
    }));
    const inspect = Object.fromEntries([...records.keys()].map((id) => [id, { kind: 'VALID' as const, inputHash: HASH_A }]));
    const enqueue = vi.fn<(
      projectId: string,
      actorAdminUserId: string,
      expectedInputHash: string,
      expectedProjectPublicId: string,
    ) => Promise<unknown>>()
      .mockResolvedValue({ resultCode: 'ENQUEUED', runId: RUN_ID, status: 'QUEUED' });
    const { fake } = gateway({ records, inspect, runs: {}, enqueue });
    const service = new BulkAssistiveExecutionService(fake);
    const ids = [...records.keys()];
    const expectedInputHashes = Object.fromEntries(ids.map((id) => [id, HASH_A]));

    const result = await service.execute({
      publicIds: ids,
      expectedInputHashes,
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability,
    });

    expect(result.summary.enqueued).toBe(50);
    expect(enqueue).toHaveBeenCalledTimes(50);
    expect('launch' in fake).toBe(false);
  });

  it('caps concurrent project coordination at four while reusing the queue gateway', async () => {
    const records = new Map(Array.from({ length: 50 }, (_, index) => {
      const id = `project-${String(index).padStart(2, '0')}`;
      return [id, record(id)] as const;
    }));
    const inspect = Object.fromEntries([...records.keys()].map((id) => [id, { kind: 'VALID' as const, inputHash: HASH_A }]));
    const { fake } = gateway({ records, inspect, runs: {} });
    let activeInspections = 0;
    let maximumActiveInspections = 0;
    fake.inspectInput = vi.fn(async (projectId) => {
      activeInspections += 1;
      maximumActiveInspections = Math.max(maximumActiveInspections, activeInspections);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeInspections -= 1;
      return inspect[projectId.replace('-db', '')];
    });
    const service = new BulkAssistiveExecutionService(fake);
    const ids = [...records.keys()];

    const result = await service.execute({
      publicIds: ids,
      expectedInputHashes: Object.fromEntries(ids.map((id) => [id, HASH_A])),
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    });

    expect(result.summary.total).toBe(50);
    expect(maximumActiveInspections).toBeLessThanOrEqual(4);
    expect('launch' in fake).toBe(false);
  });

  it('denies projects.read-only callers before any project access or enqueue', async () => {
    const { fake, enqueue } = gateway();
    const service = new BulkAssistiveExecutionService(fake);
    const actor = { adminId: ADMIN_ID, permissions: ['projects.read'] as AdminPermission[] };

    await expect(service.preflight({ publicIds: ['project-a'], actor, availability: ready }))
      .rejects.toThrow('permission denied');
    await expect(service.execute({
      publicIds: ['project-a'], expectedInputHashes: { 'project-a': HASH_A }, actor, availability: ready,
    })).rejects.toThrow('permission denied');
    expect(fake.loadProjects).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fails closed for stale input without metadata side effects', async () => {
    const { fake, enqueue } = gateway({
      records: new Map([
        ['project-a', record('project-a')],
        ['project-c', record('project-c')],
      ]),
      inspect: {
        'project-a': { kind: 'VALID', inputHash: HASH_A },
        'project-c': { kind: 'MEDIA_INVALID' },
      },
      runs: {},
    });
    const service = new BulkAssistiveExecutionService(fake);

    const result = await service.execute({
      publicIds: ['project-a'],
      expectedInputHashes: { 'project-a': HASH_B },
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    });
    expect(result.items[0].outcome).toBe('INVALID_STALE');
    expect(enqueue).not.toHaveBeenCalled();

    const blocked = await service.execute({
      publicIds: ['project-c'],
      expectedInputHashes: { 'project-c': null },
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    });
    expect(blocked.items[0].outcome).toBe('BLOCKED');
    expect(blocked.items[0].reasons[0]?.code).toBe('MEDIA_INVALID');
    expect(Object.keys(fake)).toEqual(['loadProjects', 'inspectInput', 'loadCurrentRun', 'enqueueProject']);
  });

  it('binds the expected hash and project identity at the enqueue boundary', async () => {
    const enqueue = vi.fn<(
      projectId: string,
      actorAdminUserId: string,
      expectedInputHash: string,
      expectedProjectPublicId: string,
    ) => Promise<unknown>>().mockResolvedValue({ resultCode: 'INPUT_CHANGED' });
    const { fake } = gateway({
      records: new Map([['project-a', record('project-a')]]),
      inspect: { 'project-a': { kind: 'VALID', inputHash: HASH_A } },
      runs: {},
      enqueue,
    });
    const service = new BulkAssistiveExecutionService(fake);

    const result = await service.execute({
      publicIds: ['project-a'],
      expectedInputHashes: { 'project-a': HASH_A },
      actor: { adminId: ADMIN_ID, permissions: ['projects.edit'] as AdminPermission[] },
      availability: ready,
    });

    expect(enqueue).toHaveBeenCalledWith('project-a-db', ADMIN_ID, HASH_A, 'project-a');
    expect(result.items[0]).toMatchObject({
      outcome: 'INVALID_STALE',
      inputHash: null,
      reasons: [{ code: 'INPUT_CHANGED' }],
    });
  });
});
