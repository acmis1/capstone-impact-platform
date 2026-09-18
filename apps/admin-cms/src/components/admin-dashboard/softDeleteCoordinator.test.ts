import { describe, expect, it, vi } from 'vitest';
import type { SoftDeletePreflightItem } from '../../projects/projectSoftDelete';
import { runSoftDeleteBatch } from './softDeleteCoordinator';

const item = (publicId: string, disposition: SoftDeletePreflightItem['disposition'] = 'eligible'): SoftDeletePreflightItem => ({
  publicId,
  title: `Project ${publicId}`,
  status: disposition === 'already_deleted' ? 'deleted' : 'draft',
  updatedAt: '2026-09-17T00:00:00.000Z',
  disposition,
  reasonCode: disposition === 'eligible' ? 'ELIGIBLE' : disposition === 'already_deleted' ? 'ALREADY_DELETED' : 'PUBLISHED_REQUIRES_ARCHIVE',
  reason: disposition === 'eligible' ? 'Eligible.' : 'Not eligible.',
  previouslyPublished: false,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const deleted = (publicId: string) => json({ success: true, result: {
  resultCode: 'DELETED', publicId, status: 'deleted', fromStatus: 'draft',
  deletedAt: '2026-09-17T00:00:01.000Z', auditRecordId: '11111111-1111-4111-8111-111111111111',
} });

describe('soft delete batch coordinator', () => {
  it('executes eligible projects sequentially and preserves mixed preflight outcomes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(deleted('p-1'))
      .mockResolvedValueOnce(json({ success: false, code: 'STALE_VERSION', error: 'stale' }, 409))
      .mockResolvedValueOnce(json({ success: false, code: 'CURRENTLY_PUBLIC', error: 'still public' }, 409));
    const result = await runSoftDeleteBatch({
      preflightItems: [item('p-1'), item('blocked', 'blocked'), item('already', 'already_deleted'), item('p-2'), item('p-3')],
      fetchImpl,
    });
    expect(result.items.map((entry) => entry.outcome)).toEqual([
      'DELETED', 'INELIGIBLE', 'ALREADY_DELETED', 'STALE', 'INELIGIBLE',
    ]);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      '/api/projects/p-1/soft-delete', '/api/projects/p-2/soft-delete', '/api/projects/p-3/soft-delete',
    ]);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { expectedUpdatedAt: '2026-09-17T00:00:00.000Z' },
      { expectedUpdatedAt: '2026-09-17T00:00:00.000Z' },
      { expectedUpdatedAt: '2026-09-17T00:00:00.000Z' },
    ]);
  });

  it('stops on a network-ambiguous result and leaves every later eligible project not attempted', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(deleted('p-1')).mockRejectedValueOnce(new TypeError('network'));
    const result = await runSoftDeleteBatch({ preflightItems: [item('p-1'), item('p-2'), item('p-3')], fetchImpl });
    expect(result.items.map((entry) => entry.outcome)).toEqual(['DELETED', 'UNKNOWN', 'NOT_ATTEMPTED']);
    expect(result.stopped).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports known pre-mutation request failures and continues with the next eligible project', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ success: false, error: 'Validation failed.' }, 400))
      .mockResolvedValueOnce(json({ success: false, error: 'Validation failed.' }, 413))
      .mockResolvedValueOnce(deleted('p-3'));
    const result = await runSoftDeleteBatch({ preflightItems: [item('p-1'), item('p-2'), item('p-3')], fetchImpl });
    expect(result.items.map((entry) => entry.outcome)).toEqual(['FAILED', 'FAILED', 'DELETED']);
    expect(result.stopped).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    ['mismatched ID', deleted('other')],
    ['oversized body', new Response(JSON.stringify({ success: true, padding: 'x'.repeat(33_000) }))],
    ['unclassified server failure', json({ success: false, error: 'bounded' }, 500)],
  ])('marks %s UNKNOWN and does not schedule another request', async (_label, response) => {
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const result = await runSoftDeleteBatch({ preflightItems: [item('p-1'), item('p-2')], fetchImpl });
    expect(result.items.map((entry) => entry.outcome)).toEqual(['UNKNOWN', 'NOT_ATTEMPTED']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('treats timeout as UNKNOWN because the transaction may have committed', async () => {
    const fetchImpl = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const result = await runSoftDeleteBatch({ preflightItems: [item('p-1'), item('p-2')], fetchImpl, timeoutMs: 1 });
    expect(result.items.map((entry) => entry.outcome)).toEqual(['UNKNOWN', 'NOT_ATTEMPTED']);
  });
});
