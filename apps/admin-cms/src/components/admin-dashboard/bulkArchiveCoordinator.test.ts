import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStatus } from '../../domain/workflowStatus';
import {
  prepareBulkArchiveItems,
  runBulkArchive,
  validateBulkArchiveReason,
  type BulkArchiveCandidate,
} from './bulkArchiveCoordinator';

const candidate = (publicId: string, status: WorkflowStatus = 'published'): BulkArchiveCandidate => ({
  publicId, title: `Project ${publicId}`, status,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const completed = (publicId: string, resultCode: 'COMPLETED' | 'ALREADY_COMPLETED' = 'COMPLETED') =>
  json({ success: true, result: { resultCode, publicId, recordCount: 1, feedHash: 'a'.repeat(64) } });

describe('bulk archive coordinator', () => {
  it('processes a mixed batch sequentially and preserves completed, no-change, and ineligible outcomes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(completed('published-a'))
      .mockResolvedValueOnce(completed('published-b', 'ALREADY_COMPLETED'))
      .mockResolvedValueOnce(json({ success: false, code: 'NOT_PUBLISHED', error: 'bounded' }, 409));
    const result = await runBulkArchive({
      candidates: [candidate('published-a'), candidate('published-b'), candidate('draft-c', 'draft'), candidate('stale-d')],
      reason: '  Annual showcase retirement  ', target: 'staging', fetchImpl,
    });

    expect(result.stopped).toBe(false);
    expect(result.items.map((item) => item.outcome)).toEqual([
      'COMPLETED', 'ALREADY_COMPLETED', 'INVALID_OR_INELIGIBLE', 'INVALID_OR_INELIGIBLE',
    ]);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      '/api/projects/published-a/staging-archive',
      '/api/projects/published-b/staging-archive',
      '/api/projects/stale-d/staging-archive',
    ]);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { archiveReason: 'Annual showcase retirement' },
      { archiveReason: 'Annual showcase retirement' },
      { archiveReason: 'Annual showcase retirement' },
    ]);
  });

  it('enforces empty, maximum-50, duplicate, unsafe-ID, and published-only boundaries', () => {
    expect(prepareBulkArchiveItems([])).toMatchObject({ valid: false, error: 'Select at least one project.' });
    expect(prepareBulkArchiveItems(Array.from({ length: 50 }, (_, i) => candidate(`p-${i}`))).valid).toBe(true);
    expect(prepareBulkArchiveItems(Array.from({ length: 51 }, (_, i) => candidate(`p-${i}`)))).toMatchObject({ valid: false });
    const prepared = prepareBulkArchiveItems([
      candidate('duplicate'), candidate('duplicate'), candidate('bad/id'), candidate('archived', 'archived'),
    ]);
    expect(prepared.items.map((item) => item.outcome)).toEqual([
      'NOT_ATTEMPTED', 'INVALID_OR_INELIGIBLE', 'INVALID_OR_INELIGIBLE', 'INVALID_OR_INELIGIBLE',
    ]);
  });

  it('requires a trimmed reason of at most 4,000 characters and makes no call for invalid input', async () => {
    expect(validateBulkArchiveReason('   ')).toBeNull();
    expect(validateBulkArchiveReason('x'.repeat(4000))).toBe('x'.repeat(4000));
    expect(validateBulkArchiveReason('x'.repeat(4001))).toBeNull();
    const fetchImpl = vi.fn();
    await expect(runBulkArchive({ candidates: [candidate('p-1')], reason: ' ', target: 'local', fetchImpl })).rejects.toThrow('reason');
    await expect(runBulkArchive({ candidates: Array.from({ length: 51 }, (_, i) => candidate(`p-${i}`)), reason: 'Reason', target: 'local', fetchImpl })).rejects.toThrow('50');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes no calls when every selected row is ineligible', async () => {
    const fetchImpl = vi.fn();
    const result = await runBulkArchive({
      candidates: [candidate('draft-a', 'draft'), candidate('archived-b', 'archived')],
      reason: 'Reason', target: 'local', fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.items.every((item) => item.outcome === 'INVALID_OR_INELIGIBLE')).toBe(true);
  });

  it.each([
    [401, { success: false, error: 'Authentication required.' }, 'DENIED'],
    [403, { success: false, error: 'Access denied.' }, 'DENIED'],
    [404, { success: false, code: 'PRODUCTION_ARCHIVE_UNAVAILABLE', error: 'bounded' }, 'FAILURE'],
    [409, { success: false, code: 'RECOVERY_REQUIRED', error: 'bounded' }, 'FAILURE'],
    [409, { success: false, code: 'PUBLICATION_IN_PROGRESS', error: 'bounded' }, 'FAILURE'],
    [409, { success: false, code: 'CURRENT_FEED_DIVERGED', error: 'bounded' }, 'FAILURE'],
    [500, { success: false, code: 'PRODUCTION_ARCHIVE_FAILED', error: 'bounded' }, 'FAILURE'],
  ])('stops after bounded status %s and leaves later rows not attempted', async (status, body, outcome) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(body, status as number));
    const result = await runBulkArchive({ candidates: [candidate('p-1'), candidate('p-2')], reason: 'Reason', target: 'production', fetchImpl });
    expect(result).toMatchObject({ stopped: true });
    expect(result.items.map((item) => item.outcome)).toEqual([outcome, 'NOT_ATTEMPTED']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    ['wrong public ID', json({ success: true, result: { resultCode: 'COMPLETED', publicId: 'other' } })],
    ['false HTTP success', json({ success: false, code: 'NOT_PUBLISHED' })],
    ['unrecognized failure', json({ success: false, code: 'UNEXPECTED' }, 409)],
    ['oversized payload', new Response(JSON.stringify({ success: true, padding: 'x'.repeat(33_000) }), { status: 200 })],
  ])('marks %s unknown and stops without optimistic success', async (_label, response) => {
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const result = await runBulkArchive({ candidates: [candidate('p-1'), candidate('p-2')], reason: 'Reason', target: 'local', fetchImpl });
    expect(result.items.map((item) => item.outcome)).toEqual(['UNKNOWN', 'NOT_ATTEMPTED']);
    expect(result.stopped).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves partial success before a network-ambiguous result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(completed('p-1')).mockRejectedValueOnce(new TypeError('network'));
    const result = await runBulkArchive({ candidates: [candidate('p-1'), candidate('p-2'), candidate('p-3')], reason: 'Reason', target: 'staging', fetchImpl });
    expect(result.items.map((item) => item.outcome)).toEqual(['COMPLETED', 'UNKNOWN', 'NOT_ATTEMPTED']);
    expect(result.items[1].detail).toContain('may have committed');
  });

  it('treats timeout/abort as unknown because the server may have committed', async () => {
    const fetchImpl = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const result = await runBulkArchive({ candidates: [candidate('p-1'), candidate('p-2')], reason: 'Reason', target: 'local', fetchImpl, timeoutMs: 1 });
    expect(result.items.map((item) => item.outcome)).toEqual(['UNKNOWN', 'NOT_ATTEMPTED']);
    expect(result.items[0].detail).toContain('may have committed');
  });

  it('does not schedule another write after the owning component becomes inactive', async () => {
    let active = true;
    const fetchImpl = vi.fn(async () => {
      active = false;
      return completed('p-1');
    });
    const onUpdate = vi.fn();
    const result = await runBulkArchive({
      candidates: [candidate('p-1'), candidate('p-2')], reason: 'Reason', target: 'local', fetchImpl,
      isActive: () => active, onUpdate,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.outcome)).toEqual(['UNKNOWN', 'NOT_ATTEMPTED']);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('represents 120 projects as three separately authorized 50/50/20 runs', async () => {
    const fetchImpl = vi.fn((input) => {
      const publicId = decodeURIComponent(String(input).split('/').at(-2) ?? '');
      return Promise.resolve(completed(publicId));
    });
    for (const [start, size] of [[0, 50], [50, 50], [100, 20]] as const) {
      const result = await runBulkArchive({
        candidates: Array.from({ length: size }, (_, i) => candidate(`annual-${start + i + 1}`)),
        reason: `Authorized batch ${start / 50 + 1}`, target: 'staging', fetchImpl,
      });
      expect(result.items).toHaveLength(size);
      expect(result.items.every((item) => item.outcome === 'COMPLETED')).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(120);
  });
});

describe('bulk archive interrupted-evidence boundaries', () => {
  it('does not relabel an issued request as not attempted after unmount', async () => {
    let active = true;
    const fetchImpl = vi.fn(async () => { active = false; return completed('p-1'); });
    const result = await runBulkArchive({ candidates: [candidate('p-1'), candidate('p-2')],
      reason: 'Reason', target: 'local', fetchImpl, isActive: () => active });
    expect(result.items.map(item => item.outcome)).toEqual(['UNKNOWN', 'NOT_ATTEMPTED']);
    expect(result.stopped).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('reports a cancelled-before-start batch without issuing a request', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn();
    const result = await runBulkArchive({ candidates: [candidate('p-1')], reason: 'Reason',
      target: 'local', fetchImpl, signal: controller.signal });
    expect(result.stopped).toBe(true);
    expect(result.items[0].outcome).toBe('NOT_ATTEMPTED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects an unknown runtime target before transport construction', async () => {
    const fetchImpl = vi.fn();
    await expect(runBulkArchive({ candidates: [candidate('p-1')], reason: 'Reason',
      target: 'production-unavailable' as never, fetchImpl })).rejects.toThrow(/target/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('bulk archive fixed target and bounded body cleanup', () => {
  it('captures the target once rather than re-reading mutable caller parameters', async () => {
    const input = { candidates: [candidate('p-1'), candidate('p-2')], reason: 'Reason',
      target: 'local' as 'local' | 'production', fetchImpl: vi.fn() };
    input.fetchImpl.mockImplementation(async (url: string) => {
      input.target = 'production';
      return completed(url.includes('p-1') ? 'p-1' : 'p-2');
    });
    const result = await runBulkArchive(input);
    expect(result.target).toBe('local');
    expect(input.fetchImpl.mock.calls.map(call => call[0])).toEqual([
      '/api/projects/p-1/local-archive', '/api/projects/p-2/local-archive',
    ]);
  });
  it('cancels an oversized response body and stops without forwarding another request', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(33_000)); }, cancel,
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body));
    const result = await runBulkArchive({ candidates: [candidate('p-1'), candidate('p-2')],
      target: 'local', reason: 'Reason', fetchImpl });
    expect(result.items.map(item => item.outcome)).toEqual(['UNKNOWN', 'NOT_ATTEMPTED']);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
