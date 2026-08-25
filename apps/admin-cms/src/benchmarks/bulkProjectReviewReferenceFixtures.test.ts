import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  acquireBulkReviewReferenceFixtures,
  cleanupBulkReviewReferenceFixtures,
  referenceFixtureCleanupIsClean,
} from './bulkProjectReviewReferenceFixtures';

type ReferenceTable = 'programs' | 'disciplines' | 'industry_categories';

class ReferenceCatalogClient {
  private nextId = 0;

  constructor(private readonly rows: Record<ReferenceTable, Array<{ id: string; name: string }>>) {}

  from(table: ReferenceTable) {
    return {
      select: (...args: [string, { count?: 'exact'; head?: boolean }?]) => {
        const options = args[1];
        return {
          limit: async () => this.response(table, options),
          in: async (_column: string, ids: string[]) => this.response(table, options, ids),
        };
      },
      insert: ({ name }: { name: string }) => ({
        select: () => ({
          single: async () => {
            const row = { id: `owned-${++this.nextId}`, name };
            this.rows[table].push(row);
            return { data: { id: row.id }, error: null };
          },
        }),
      }),
      delete: () => ({
        in: async (_column: string, ids: string[]) => {
          this.rows[table] = this.rows[table].filter((row) => !ids.includes(row.id));
          return { error: null };
        },
      }),
    };
  }

  snapshot(table: ReferenceTable): Array<{ id: string; name: string }> {
    return this.rows[table].map((row) => ({ ...row }));
  }

  private response(table: ReferenceTable, options?: { count?: 'exact'; head?: boolean }, ids?: string[]) {
    const rows = ids ? this.rows[table].filter((row) => ids.includes(row.id)) : this.rows[table];
    return {
      data: options?.head ? null : rows.map(({ id }) => ({ id })),
      error: null,
      count: options?.head ? rows.length : null,
    };
  }
}

function client(rows: Partial<Record<ReferenceTable, Array<{ id: string; name: string }>>> = {}) {
  const catalog = new ReferenceCatalogClient({ programs: [], disciplines: [], industry_categories: [], ...rows });
  return { catalog, supabase: catalog as unknown as SupabaseClient };
}

describe('bulk project review taxonomy fixtures', () => {
  it('creates and removes only verifier-owned references for an empty catalog', async () => {
    const { catalog, supabase } = client();
    const fixtures = await acquireBulkReviewReferenceFixtures(supabase, 'runtime-empty-catalog');

    expect(fixtures.ownership).toEqual({ programIds: ['owned-1'], disciplineIds: ['owned-2'], industryIds: ['owned-3'] });
    expect(await cleanupBulkReviewReferenceFixtures(supabase, fixtures.ownership)).toEqual({ programs: 0, disciplines: 0, industryCategories: 0 });
    expect(referenceFixtureCleanupIsClean({ programs: 0, disciplines: 0, industryCategories: 0 })).toBe(true);
    expect(catalog.snapshot('programs')).toEqual([]);
    expect(catalog.snapshot('disciplines')).toEqual([]);
    expect(catalog.snapshot('industry_categories')).toEqual([]);
  });

  it('preserves pre-existing references and creates only missing categories across repeated runs', async () => {
    const existingProgram = { id: 'existing-program', name: 'Existing Program' };
    const existingIndustry = { id: 'existing-industry', name: 'Existing Industry' };
    const { catalog, supabase } = client({ programs: [existingProgram], industry_categories: [existingIndustry] });

    const first = await acquireBulkReviewReferenceFixtures(supabase, 'functional-mixed-catalog-one');
    expect(first.programIds).toEqual([existingProgram.id]);
    expect(first.industryIds).toEqual([existingIndustry.id]);
    expect(first.ownership).toEqual({ programIds: [], disciplineIds: ['owned-1'], industryIds: [] });
    await cleanupBulkReviewReferenceFixtures(supabase, first.ownership);

    const second = await acquireBulkReviewReferenceFixtures(supabase, 'functional-mixed-catalog-two');
    await cleanupBulkReviewReferenceFixtures(supabase, second.ownership);
    expect(catalog.snapshot('programs')).toEqual([existingProgram]);
    expect(catalog.snapshot('industry_categories')).toEqual([existingIndustry]);
    expect(catalog.snapshot('disciplines')).toEqual([]);
  });

  it('keeps both bulk verifiers on the shared self-contained fixture path', () => {
    const root = path.resolve(__dirname);
    for (const file of ['bulkProjectReviewRuntime.ts', 'bulkProjectReviewFunctionalWorkflow.ts']) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain('acquireBulkReviewReferenceFixtures');
    }
  });
});
