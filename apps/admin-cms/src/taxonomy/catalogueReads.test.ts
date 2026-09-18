import { describe, expect, it, vi } from 'vitest';
import { readCatalogueRows } from './catalogueRows';
import { withCatalogueUsage } from './catalogueUsage';
import { parseTaxonomyLifecycleResponse } from './taxonomyLifecycleResponse';

function provider(rows: Record<string, unknown>[], cap: number) {
  const range = vi.fn(async (start: number, end: number) => ({ data: rows.slice(start, Math.min(end + 1, start + cap)), error: null }));
  const query = { select: () => query, order: () => query, range };
  return { client: { from: () => query } as never, range };
}

describe('retained catalogue read and lifecycle evidence', () => {
  it('reads beyond 1000 records without mistaking a smaller provider cap for completion', async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => ({ id: `id-${String(i).padStart(5, '0')}` }));
    const db = provider(rows, 37);
    expect(await readCatalogueRows(db.client, 'projects', 'id', ['id'])).toEqual(rows);
    expect(db.range).toHaveBeenLastCalledWith(1201, 1700);
  });
  it('refuses repeated identities instead of returning an unreliable total', async () => {
    const db = provider([{ id: 'one' }, { id: 'one' }], 1);
    await expect(readCatalogueRows(db.client, 'projects', 'id', ['id'])).rejects.toThrow('changed during paging');
  });
  it('counts canonical and legacy references once per retained project, including deleted rows', () => {
    const rows = { program: [{ id: 'p', name: 'Program', usageCount: 0 }], discipline: [{ id: 'd', name: 'Discipline', usageCount: 0 }], industryCategory: [{ id: 'i', name: 'Industry', usageCount: 0 }] };
    const projects = [{ id: 'one', program_id: 'p', program_name: 'Program', study_program: 'PROGRAM', discipline: 'Discipline', industry: 'Industry' }, { id: 'two', status: 'deleted', program_name: ' program ', discipline: 'discipline', industry: 'industry' }];
    const result = withCatalogueUsage(rows, projects, [{ project_id: 'one', discipline_id: 'd' }], [{ project_id: 'one', industry_category_id: 'i' }]);
    expect(result.program[0].usageCount).toBe(2); expect(result.discipline[0].usageCount).toBe(2); expect(result.industryCategory[0].usageCount).toBe(2);
  });
  it('requires exact lifecycle identity, result, timestamp and revision', () => {
    const expected = { taxonomyId: '11111111-1111-4111-8111-111111111111', action: 'retire' as const, expectedLifecycleVersion: 1 };
    const result = { resultCode: 'RETIRED', id: expected.taxonomyId, name: 'Synthetic value', retiredAt: '2026-09-18T12:00:00.000Z', lifecycleVersion: 2 };
    expect(parseTaxonomyLifecycleResponse(result, expected)).toEqual(result);
    for (const patch of [{ id: '22222222-2222-4222-8222-222222222222' }, { retiredAt: null }, { retiredAt: 'invalid' }, { lifecycleVersion: 1 }, { lifecycleVersion: 2.5 }, { resultCode: 'RENAMED' }, { unexpected: true }]) {
      expect(() => parseTaxonomyLifecycleResponse({ ...result, ...patch }, expected)).toThrow();
    }
    expect(parseTaxonomyLifecycleResponse({ resultCode: 'BUSY' }, expected)).toEqual({ resultCode: 'BUSY' });
    expect(() => parseTaxonomyLifecycleResponse({ resultCode: 'UNKNOWN_SUCCESS' }, expected)).toThrow();
  });
});
