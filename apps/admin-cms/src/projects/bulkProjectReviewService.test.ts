import { describe, expect, it, vi } from 'vitest';
import { BulkReviewService, type BulkProjectReviewGateway } from './bulkProjectReviewService';
import type { BulkReviewProjectState } from './bulkProjectReview';

function state(publicId: string, overrides: Partial<BulkReviewProjectState> = {}): BulkReviewProjectState {
  return {
    publicId,
    title: `Project ${publicId}`,
    status: 'draft',
    updatedAt: '2026-08-24T00:00:00.000Z',
    exists: true,
    submission: { eligible: true, alreadyComplete: false, reasons: [] },
    review: {
      approve: { allowed: false, reasons: [{ code: 'INVALID_PROJECT_STATE', message: 'Not approvable.' }] },
      requestChanges: { allowed: false, reasons: [{ code: 'INVALID_PROJECT_STATE', message: 'Not requestable.' }] },
    },
    ...overrides,
  };
}

function gateway(states: BulkReviewProjectState[]): BulkProjectReviewGateway & { loads: number; executed: string[] } {
  const result = {
    loads: 0,
    executed: [] as string[],
    async loadProjectStates(ids: string[]) {
      result.loads += 1;
      return new Map(states.filter((item) => ids.includes(item.publicId)).map((item) => [item.publicId, item]));
    },
    async executeAction(params: { publicId: string }) {
      result.executed.push(params.publicId);
      return { resultCode: 'SUCCESS' as const, status: 'submitted' as const, auditRecorded: true };
    },
  };
  return result;
}

describe('BulkProjectReviewService', () => {
  it('performs one execution-time set-based load, executes eligible IDs in public-ID order, and returns every item', async () => {
    const reviewGateway = gateway([
      state('z-1'),
      state('a-1'),
      state('b-1', {
        submission: { eligible: false, alreadyComplete: false, reasons: [{ code: 'READINESS_BLOCKED', message: 'Missing summary.' }] },
      }),
      state('c-1', { status: 'submitted' }),
    ]);
    const service = new BulkReviewService(reviewGateway);
    const result = await service.execute({
      action: 'submit_for_review',
      publicIds: ['z-1', 'b-1', 'missing-1', 'c-1', 'a-1'],
      expectedUpdatedAt: {
        'z-1': '2026-08-24T00:00:00.000Z',
        'b-1': '2026-08-24T00:00:00.000Z',
        'missing-1': null,
        'c-1': '2026-08-24T00:00:00.000Z',
        'a-1': '2026-08-24T00:00:00.000Z',
      },
      actor: { adminId: 'admin-1', permissions: ['projects.edit'] },
    });

    expect(reviewGateway.loads).toBe(1);
    expect(reviewGateway.executed).toEqual(['a-1', 'z-1']);
    expect(result.items.map((item) => item.publicId)).toEqual(['a-1', 'b-1', 'c-1', 'missing-1', 'z-1']);
    expect(result.summary).toMatchObject({ total: 5, successful: 2, blocked: 1, alreadyComplete: 1, invalidOrStale: 1, failed: 0 });
    expect(result.items.find((item) => item.publicId === 'b-1')?.outcome).toBe('blocked');
    expect(result.items.find((item) => item.publicId === 'c-1')?.outcome).toBe('already_complete');
    expect(result.items.find((item) => item.publicId === 'missing-1')?.outcome).toBe('invalid_or_stale');
  });

  it('keeps a gateway failure bounded and continues with later projects', async () => {
    const reviewGateway = gateway([state('a-1'), state('b-1')]);
    const originalExecute = reviewGateway.executeAction;
    reviewGateway.executeAction = vi.fn(async (params: { publicId: string; expectedUpdatedAt: string; action: 'submit_for_review'; adminId: string }) => {
      if (params.publicId === 'a-1') throw new Error('database details must not escape');
      return originalExecute(params);
    });
    const result = await new BulkReviewService(reviewGateway).execute({
      action: 'submit_for_review',
      publicIds: ['a-1', 'b-1'],
      expectedUpdatedAt: { 'a-1': '2026-08-24T00:00:00.000Z', 'b-1': '2026-08-24T00:00:00.000Z' },
      actor: { adminId: 'admin-1', permissions: ['projects.edit'] },
    });
    expect(result.summary).toMatchObject({ successful: 1, failed: 1 });
    expect(JSON.stringify(result)).not.toContain('database details');
  });

  it('enforces the existing permission matrix at the service boundary', async () => {
    const reviewGateway = gateway([state('a-1')]);
    await expect(new BulkReviewService(reviewGateway).preflight({
      action: 'submit_for_review', publicIds: ['a-1'], actor: { adminId: 'reviewer-1', permissions: ['projects.review'] },
    })).rejects.toThrow('permission denied');
    await expect(new BulkReviewService(reviewGateway).preflight({
      action: 'approve', publicIds: ['a-1'], actor: { adminId: 'editor-1', permissions: ['projects.edit'] },
    })).rejects.toThrow('permission denied');
  });

  it.each([
    ['approve', 'approved'],
    ['request_changes', 'changes_requested'],
  ] as const)('reports a successful %s review with its authoritative resulting status and audit', async (action, status) => {
    const reviewGateway = gateway([state('a-1', {
      status: 'submitted',
      review: { approve: { allowed: true, reasons: [] }, requestChanges: { allowed: true, reasons: [] } },
    })]);
    reviewGateway.executeAction = vi.fn(async () => ({ resultCode: 'SUCCESS' as const, status, auditRecorded: true }));
    const result = await new BulkReviewService(reviewGateway).execute({
      action,
      publicIds: ['a-1'],
      expectedUpdatedAt: { 'a-1': '2026-08-24T00:00:00.000Z' },
      comments: action === 'request_changes' ? 'Please revise the accessibility content.' : undefined,
      actor: { adminId: 'admin-1', permissions: ['projects.review'] },
    });
    expect(result.summary).toMatchObject({ successful: 1, blocked: 0, invalidOrStale: 0, failed: 0 });
    expect(result.items[0]).toMatchObject({ outcome: 'successful', status, auditRecorded: true });
  });

  it('never fabricates a status when execution fails, and preserves authoritative blocked/stale statuses', async () => {
    const reviewGateway = gateway([
      state('blocked-1', { status: 'submitted', review: { approve: { allowed: false, reasons: [{ code: 'BLOCKED', message: 'Blocked.' }] }, requestChanges: { allowed: true, reasons: [] } } }),
      state('stale-1', { status: 'submitted', review: { approve: { allowed: true, reasons: [] }, requestChanges: { allowed: true, reasons: [] } } }),
      state('failed-1', { status: 'submitted', review: { approve: { allowed: true, reasons: [] }, requestChanges: { allowed: true, reasons: [] } } }),
    ]);
    reviewGateway.executeAction = vi.fn(async ({ publicId }: { publicId: string }) => {
      if (publicId === 'blocked-1') return { resultCode: 'BLOCKED' as const, status: 'submitted' as const, auditRecorded: false, reason: { code: 'BLOCKED', message: 'Blocked.' } };
      if (publicId === 'stale-1') return { resultCode: 'STALE_VERSION' as const, status: 'submitted' as const, auditRecorded: false, reason: { code: 'STALE_VERSION', message: 'Stale.' } };
      return { resultCode: 'FAILED' as const, status: null, auditRecorded: false, reason: { code: 'FAILED', message: 'Failed.' } };
    });
    const result = await new BulkReviewService(reviewGateway).execute({
      action: 'approve',
      publicIds: ['blocked-1', 'stale-1', 'failed-1'],
      expectedUpdatedAt: { 'blocked-1': '2026-08-24T00:00:00.000Z', 'stale-1': 'old', 'failed-1': '2026-08-24T00:00:00.000Z' },
      actor: { adminId: 'admin-1', permissions: ['projects.review'] },
    });
    expect(result.items.find((item) => item.publicId === 'blocked-1')).toMatchObject({ outcome: 'blocked', status: 'submitted', auditRecorded: false });
    expect(result.items.find((item) => item.publicId === 'stale-1')).toMatchObject({ outcome: 'invalid_or_stale', status: 'submitted', auditRecorded: false });
    expect(result.items.find((item) => item.publicId === 'failed-1')).toMatchObject({ outcome: 'failed', status: null, auditRecorded: false });
    expect(JSON.stringify(result)).not.toContain('draft');
  });

  it('requires a non-empty shared comment for request changes at the service boundary', async () => {
    const reviewGateway = gateway([state('a-1', { status: 'submitted', review: { approve: { allowed: true, reasons: [] }, requestChanges: { allowed: true, reasons: [] } } })]);
    await expect(new BulkReviewService(reviewGateway).execute({
      action: 'request_changes', publicIds: ['a-1'], expectedUpdatedAt: { 'a-1': '2026-08-24T00:00:00.000Z' },
      comments: '   ', actor: { adminId: 'admin-1', permissions: ['projects.review'] },
    })).rejects.toThrow('comments are required');
  });
});
