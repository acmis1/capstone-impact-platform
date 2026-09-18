import { describe, expect, it, vi } from 'vitest';
import { ImportBatchRepositoryCore } from '../repositories/ImportBatchRepositoryCore';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseImportHistoryQuery, importHistoryHref } from './importHistoryQuery';

describe('bounded import history', () => {
  it('validates paging/filter input and preserves only allowed query fields in navigation', () => {
    const query = parseImportHistoryQuery({ page: '3', q: 'Synthetic batch', year: '2026', status: 'completed', token: 'never-propagate' });
    expect(query).toEqual({ page: 3, q: 'Synthetic batch', year: '2026', status: 'completed' });
    const url = new URL(importHistoryHref(query, 2), 'https://synthetic.invalid');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('q')).toBe('Synthetic batch');
    expect(url.searchParams.has('token')).toBe(false);
    for (const input of [{ page: '-1' }, { page: 'Infinity' }, { page: '10001' }, { q: 'x'.repeat(101) }, { year: '2026,or(id.gt.0)' }, { status: 'made_up' }]) expect(() => parseImportHistoryQuery(input)).toThrow();
  });
  it('uses stable server pagination and exact bounded filters rather than truncating all history', async () => {
    const request = { select: vi.fn(), ilike: vi.fn(), eq: vi.fn(), gte: vi.fn(), lt: vi.fn(), order: vi.fn(), range: vi.fn().mockResolvedValue({ data: [], count: 101, error: null }) };
    for (const name of ['select', 'ilike', 'eq', 'gte', 'lt', 'order'] as const) request[name].mockReturnValue(request);
    const client = { from: vi.fn().mockReturnValue(request) };
    const repository = new ImportBatchRepositoryCore(client as unknown as SupabaseClient);
    const result = await repository.listImportHistory(parseImportHistoryQuery({ page: 3, q: '100%_batch', year: '2026', status: 'completed' }));
    expect(result).toEqual({ batches: [], total: 101 });
    expect(request.range).toHaveBeenCalledWith(40, 59);
    expect(request.ilike).toHaveBeenCalledWith('batch_name', '%100\\%\\_batch%');
    expect(request.gte).toHaveBeenCalledWith('created_at', '2026-01-01T00:00:00Z');
    expect(request.lt).toHaveBeenCalledWith('created_at', '2027-01-01T00:00:00Z');
    expect(request.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false });
  });
});
