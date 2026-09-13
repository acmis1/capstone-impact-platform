import { describe, it, expect, vi } from 'vitest';
import { SupabaseProjectRepositoryCore } from './SupabaseProjectRepositoryCore';
import { ProjectListQuery, AllowedSortField } from '../domain/projectQuery';
import type { DatabaseProjectRow } from './SupabaseProjectRepositoryCore';

interface OrderCall {
  column: string;
  options?: { ascending?: boolean };
}

interface RangeCall {
  from: number;
  to: number;
}

interface QueryExecutionLog {
  table?: string;
  selectFields?: string;
  selectOpts?: unknown;
  isCol?: string;
  isVal?: unknown;
  orClause?: string;
  eqFilters?: Record<string, unknown>;
  inFilters?: Record<string, unknown[]>;
  orders: OrderCall[];
  ranges: RangeCall[];
}

function createSequentialMockSupabaseClient(responses: Array<{ data: unknown[]; count?: number }>) {
  let queryIndex = 0;
  const executionLogs: QueryExecutionLog[] = [];

  const createQueryBuilder = () => {
    const currentLog: QueryExecutionLog = {
      orders: [],
      ranges: [],
    };
    executionLogs.push(currentLog);

    const builder: Record<string, unknown> = {
      select: vi.fn().mockImplementation((fields, opts) => {
        currentLog.selectFields = fields;
        currentLog.selectOpts = opts;
        return builder;
      }),
      is: vi.fn().mockImplementation((col, val) => {
        currentLog.isCol = col;
        currentLog.isVal = val;
        return builder;
      }),
      or: vi.fn().mockImplementation((clause) => {
        currentLog.orClause = clause;
        return builder;
      }),
      eq: vi.fn().mockImplementation((col, val) => {
        if (!currentLog.eqFilters) currentLog.eqFilters = {};
        currentLog.eqFilters[col] = val;
        return builder;
      }),
      in: vi.fn().mockImplementation((col, vals) => {
        if (!currentLog.inFilters) currentLog.inFilters = {};
        currentLog.inFilters[col] = vals;
        return builder;
      }),
      order: vi.fn().mockImplementation((column, options) => {
        currentLog.orders.push({ column, options });
        return builder;
      }),
      range: vi.fn().mockImplementation((from, to) => {
        currentLog.ranges.push({ from, to });
        return builder;
      }),
      then: vi.fn().mockImplementation((resolve) => {
        const resp = responses[queryIndex] || { data: [], count: 0 };
        queryIndex++;
        resolve({
          data: resp.data,
          count: resp.count !== undefined ? resp.count : null,
          error: null,
        });
      }),
    };

    return builder;
  };

  const client = {
    from: vi.fn().mockImplementation((table) => {
      const builder = createQueryBuilder();
      const lastLog = executionLogs[executionLogs.length - 1];
      if (lastLog) lastLog.table = table;
      return builder;
    }),
    _executionLogs: executionLogs,
  };

  return client as unknown as import('@supabase/supabase-js').SupabaseClient & {
    _executionLogs: QueryExecutionLog[];
  };
}

function createTaxonomyAwareMockSupabaseClient(rows: DatabaseProjectRow[]) {
  const executionLogs: QueryExecutionLog[] = [];

  const client = {
    from: vi.fn().mockImplementation((table: string) => {
      const currentLog: QueryExecutionLog = { table, orders: [], ranges: [] };
      executionLogs.push(currentLog);
      const eqFilters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: vi.fn().mockImplementation((fields, opts) => {
          currentLog.selectFields = fields;
          currentLog.selectOpts = opts;
          return builder;
        }),
        is: vi.fn().mockImplementation((column, value) => {
          currentLog.isCol = column;
          currentLog.isVal = value;
          return builder;
        }),
        eq: vi.fn().mockImplementation((column, value) => {
          eqFilters[column] = value;
          currentLog.eqFilters = eqFilters;
          return builder;
        }),
        order: vi.fn().mockImplementation((column, options) => {
          currentLog.orders.push({ column, options });
          return builder;
        }),
        range: vi.fn().mockImplementation((from, to) => {
          currentLog.ranges.push({ from, to });
          return builder;
        }),
        then: vi.fn().mockImplementation((resolve) => {
          const matchingRows = rows.filter((row) => Object.entries(eqFilters).every(([column, value]) => {
            if (column === 'discipline_filter.disciplines.name') {
              return row.project_disciplines?.some((mapping) => mapping.disciplines?.name === value);
            }
            if (column === 'industry_filter.industry_categories.name') {
              return row.project_industry_categories?.some((mapping) => mapping.industry_categories?.name === value);
            }
            return (row as unknown as Record<string, unknown>)[column] === value;
          }));
          const orderedRows = [...matchingRows].sort((left, right) => left.public_id.localeCompare(right.public_id));
          const range = currentLog.ranges[0];
          const data = range ? orderedRows.slice(range.from, range.to + 1) : orderedRows;
          resolve({ data, count: orderedRows.length, error: null });
        }),
      };
      return builder;
    }),
    _executionLogs: executionLogs,
  };

  return client as unknown as import('@supabase/supabase-js').SupabaseClient & {
    _executionLogs: QueryExecutionLog[];
  };
}

describe('SupabaseProjectRepositoryCore query operations', () => {
  it('keeps 120 parent projects unique across secondary discipline, industry, and intersection filters', async () => {
    const rows: DatabaseProjectRow[] = Array.from({ length: 120 }, (_, index) => ({
      id: `uuid-${index + 1}`,
      public_id: `2026-project-${String(index + 1).padStart(3, '0')}`,
      title: `Synthetic project ${index + 1}`,
      year: 2026,
      program_name: 'Synthetic Program',
      discipline: 'Primary discipline',
      industry: 'Legacy scalar industry',
      project_disciplines: [
        { disciplines: { name: 'Primary discipline' } },
        ...(index === 0 || index === 60 ? [{ disciplines: { name: 'Artificial Intelligence' } }] : []),
      ],
      project_industry_categories: [
        { industry_categories: { name: index % 2 === 0 ? 'Technology' : 'Healthcare' } },
        ...(index === 0 ? [{ industry_categories: { name: 'Healthcare' } }] : []),
      ],
    }));
    const mockClient = createTaxonomyAwareMockSupabaseClient(rows);
    const repo = new SupabaseProjectRepositoryCore(mockClient);

    const allProjects = await repo.listProjectsPage({ page: 1, pageSize: 50 });
    const technology = await repo.listProjectsPage({ page: 2, pageSize: 25, industry: 'Technology' });
    const secondaryDiscipline = await repo.listProjectsPage({ page: 1, pageSize: 10, discipline: 'Artificial Intelligence' });
    const intersection = await repo.listProjectsPage({ page: 1, pageSize: 10, discipline: 'Artificial Intelligence', industry: 'Healthcare' });

    expect(allProjects).toMatchObject({ total: 120, page: 1, pageSize: 50, pageCount: 3 });
    expect(allProjects.projects).toHaveLength(50);
    expect(technology).toMatchObject({ total: 60, page: 2, pageSize: 25, pageCount: 3 });
    expect(technology.projects).toHaveLength(25);
    expect(secondaryDiscipline).toMatchObject({ total: 2, pageCount: 1 });
    expect(secondaryDiscipline.projects.map((project) => project.publicId)).toEqual([
      '2026-project-001',
      '2026-project-061',
    ]);
    expect(intersection).toMatchObject({ total: 1, pageCount: 1 });
    expect(intersection.projects.map((project) => project.publicId)).toEqual(['2026-project-001']);
    expect(intersection.projects[0].disciplines).toEqual(['Primary discipline', 'Artificial Intelligence']);
    expect(new Set(technology.projects.map((project) => project.publicId)).size).toBe(25);
  });

  it('lists lifecycle projects with the unique public ID as a deterministic timestamp tie-breaker', async () => {
    const mockClient = createSequentialMockSupabaseClient([{ data: [], count: 0 }]);
    const repo = new SupabaseProjectRepositoryCore(mockClient);

    await repo.listProjects();

    expect(mockClient._executionLogs[0].orders).toEqual([
      { column: 'created_at', options: { ascending: false } },
      { column: 'public_id', options: { ascending: true } },
    ]);
  });

  // ============================================================
  // listProjectsPage
  // ============================================================

  it('applies is("deleted_at", null) and range 0-9 for page 1 / pageSize 10', async () => {
    const mockClient = createSequentialMockSupabaseClient([
      { data: [{ id: 'uuid-1', public_id: '2026-proj1', title: 'Proj 1', status: 'approved' }], count: 1 },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = { page: 1, pageSize: 10, sort: 'created_at', direction: 'desc' };

    const result = await repo.listProjectsPage(query);

    const log = mockClient._executionLogs[0];
    expect(log.table).toBe('projects');
    expect(log.isCol).toBe('deleted_at');
    expect(log.isVal).toBeNull();
    expect(log.ranges[0]).toEqual({ from: 0, to: 9 });
    expect(result.total).toBe(1);
    expect(result.projects.length).toBe(1);
  });

  it('applies selected primary order first and public_id ASC second', async () => {
    const mockClient = createSequentialMockSupabaseClient([{ data: [], count: 50 }]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = { page: 2, pageSize: 25, sort: 'year', direction: 'asc' };

    await repo.listProjectsPage(query);

    const log = mockClient._executionLogs[0];
    expect(log.ranges[0]).toEqual({ from: 25, to: 49 });
    expect(log.orders).toEqual([
      { column: 'year', options: { ascending: true } },
      { column: 'public_id', options: { ascending: true } },
    ]);
  });

  it('filters discipline and industry through inner taxonomy relationships while retaining complete discipline mappings', async () => {
    const mockClient = createSequentialMockSupabaseClient([
      {
        data: [{
          id: 'uuid-1',
          public_id: '2026-proj1',
          discipline: 'Software Engineering',
          project_disciplines: [
            { disciplines: { name: 'Software Engineering' } },
            { disciplines: { name: 'Artificial Intelligence' } },
          ],
        }],
        count: 1,
      },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const result = await repo.listProjectsPage({
      page: 1,
      pageSize: 10,
      discipline: 'Artificial Intelligence',
      industry: 'Technology',
    });

    const log = mockClient._executionLogs[0];
    expect(log.selectFields).toContain('project_disciplines(disciplines(name))');
    expect(log.selectFields).toContain('discipline_filter:project_disciplines!inner(disciplines!inner(name))');
    expect(log.selectFields).toContain('industry_filter:project_industry_categories!inner(industry_categories!inner(name))');
    expect(log.eqFilters?.['discipline_filter.disciplines.name']).toBe('Artificial Intelligence');
    expect(log.eqFilters?.['industry_filter.industry_categories.name']).toBe('Technology');
    expect(result.projects[0].disciplines).toEqual(['Software Engineering', 'Artificial Intelligence']);
  });

  it('clamps out-of-range requested page to final page with proper sequential re-query and identical ordering', async () => {
    // Given requested page 99, pageSize 10, exact total 23 (pageCount = 3)
    const mockClient = createSequentialMockSupabaseClient([
      // Initial query for page 99 (range 980-989) returns total 23 but 0 rows
      { data: [], count: 23 },
      // Re-query for clamped page 3 (range 20-29) returns the 3 final page rows
      {
        data: [
          { id: 'uuid-21', public_id: '2026-proj21', title: 'Proj 21', status: 'published' },
          { id: 'uuid-22', public_id: '2026-proj22', title: 'Proj 22', status: 'published' },
          { id: 'uuid-23', public_id: '2026-proj23', title: 'Proj 23', status: 'published' },
        ],
      },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = { page: 99, pageSize: 10, sort: 'created_at', direction: 'desc' };

    const result = await repo.listProjectsPage(query);

    expect(mockClient._executionLogs.length).toBe(2);
    // Initial query range 980-989
    expect(mockClient._executionLogs[0].ranges[0]).toEqual({ from: 980, to: 989 });
    // Clamped query range 20-29
    expect(mockClient._executionLogs[1].ranges[0]).toEqual({ from: 20, to: 29 });

    // Both queries must have identical primary+secondary ordering
    const expectedOrders = [
      { column: 'created_at', options: { ascending: false } },
      { column: 'public_id', options: { ascending: true } },
    ];
    expect(mockClient._executionLogs[0].orders).toEqual(expectedOrders);
    expect(mockClient._executionLogs[1].orders).toEqual(expectedOrders);

    // Verify result returned page 3 and 3 records
    expect(result.page).toBe(3);
    expect(result.pageCount).toBe(3);
    expect(result.total).toBe(23);
    expect(result.projects.length).toBe(3);
    expect(result.projects[0].publicId).toBe('2026-proj21');
  });

  it('does not execute a second query for empty collection (total = 0)', async () => {
    const mockClient = createSequentialMockSupabaseClient([{ data: [], count: 0 }]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = { page: 5, pageSize: 10 };

    const result = await repo.listProjectsPage(query);

    expect(mockClient._executionLogs.length).toBe(1);
    expect(result.page).toBe(5);
    expect(result.pageCount).toBe(0);
    expect(result.total).toBe(0);
    expect(result.projects.length).toBe(0);
  });

  it('constructs .or() clause with exactly the four approved search columns and normalized input', async () => {
    const mockClient = createSequentialMockSupabaseClient([{ data: [], count: 0 }]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = {
      search: "title:eq.test(123),select*%20;'\"\\_DROP--",
      page: 1,
      pageSize: 10,
    };

    await repo.listProjectsPage(query);

    const log = mockClient._executionLogs[0];
    expect(log.orClause).toBe(
      'title.ilike.%title eq test 123 select 20 DROP--%,public_id.ilike.%title eq test 123 select 20 DROP--%,industry_partner.ilike.%title eq test 123 select 20 DROP--%,group_name.ilike.%title eq test 123 select 20 DROP--%'
    );
    expect(log.orClause).not.toContain('(');
    expect(log.orClause).not.toContain(')');
    expect(log.orClause).not.toContain(';');
    expect(log.orClause).not.toContain("'");
    expect(log.orClause).not.toContain('"');
    expect(log.orClause).not.toContain('\\');
  });

  it('falls back to created_at primary order when malformed runtime sort value is passed', async () => {
    const mockClient = createSequentialMockSupabaseClient([{ data: [], count: 0 }]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = {
      sort: 'unsupported_column; DROP TABLE projects;' as AllowedSortField,
      direction: 'desc',
      page: 1,
      pageSize: 10,
    };

    await repo.listProjectsPage(query);

    const log = mockClient._executionLogs[0];
    expect(log.orders[0]).toEqual({ column: 'created_at', options: { ascending: false } });
    expect(log.orders[1]).toEqual({ column: 'public_id', options: { ascending: true } });
  });

  // ============================================================
  // getProjectDashboardMetrics — count-only queries
  // ============================================================

  it('runs four concurrent count-only HEAD queries and maps counts to the metrics object', async () => {
    // Four concurrent Promise.all responses: total, publicEligible, inReview, archived
    const mockClient = createSequentialMockSupabaseClient([
      { data: [], count: 42 },  // total (deleted_at IS NULL)
      { data: [], count: 10 },  // publicEligible (approved + published)
      { data: [], count: 5 },   // inReview
      { data: [], count: 3 },   // archived
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const metrics = await repo.getProjectDashboardMetrics();

    expect(metrics).toEqual({
      totalProjects: 42,
      publicEligible: 10,
      inReview: 5,
      archived: 3,
    });

    // All four queries must be count-only (head: true)
    expect(mockClient._executionLogs.length).toBe(4);
    for (const log of mockClient._executionLogs) {
      expect(log.table).toBe('projects');
      expect(log.isCol).toBe('deleted_at');
      expect(log.isVal).toBeNull();
      expect((log.selectOpts as { head?: boolean })?.head).toBe(true);
      // Must NOT contain full status row arrays
      expect(log.selectFields).toBe('id');
    }
  });

  it('applies correct status filter for each metric query', async () => {
    const mockClient = createSequentialMockSupabaseClient([
      { data: [], count: 100 }, // total — no status filter
      { data: [], count: 20 },  // publicEligible — .in('status', ['approved','published'])
      { data: [], count: 8 },   // inReview — .eq('status', 'in_review')
      { data: [], count: 4 },   // archived — .eq('status', 'archived')
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    await repo.getProjectDashboardMetrics();

    const [totalLog, publicLog, reviewLog, archiveLog] = mockClient._executionLogs;

    // Total: no status filter
    expect(totalLog.inFilters).toBeUndefined();
    expect(totalLog.eqFilters?.['status']).toBeUndefined();

    // Public-eligible: .in('status', ['approved', 'published'])
    expect(publicLog.inFilters?.['status']).toEqual(['approved', 'published']);

    // In-review: .eq('status', 'in_review')
    expect(reviewLog.eqFilters?.['status']).toBe('in_review');

    // Archived: .eq('status', 'archived')
    expect(archiveLog.eqFilters?.['status']).toBe('archived');
  });

  it('treats a null count as zero for any metric query', async () => {
    // Simulate Supabase returning null counts
    const mockClient = createSequentialMockSupabaseClient([
      { data: [], count: undefined }, // total returns undefined → null
      { data: [], count: undefined },
      { data: [], count: undefined },
      { data: [], count: undefined },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const metrics = await repo.getProjectDashboardMetrics();

    expect(metrics.totalProjects).toBe(0);
    expect(metrics.publicEligible).toBe(0);
    expect(metrics.inReview).toBe(0);
    expect(metrics.archived).toBe(0);
  });

  // ============================================================
  // getProjectFilterOptions — chunked pagination
  // ============================================================

  it('performs one query when response is shorter than chunk size', async () => {
    const mockClient = createSequentialMockSupabaseClient([
      {
        data: [
          { year: 2026, program_name: 'CS', project_disciplines: [{ disciplines: { name: 'AI' } }, { disciplines: { name: 'Artificial Intelligence' } }], project_industry_categories: [{ industry_categories: { name: 'Technology' } }, { industry_categories: { name: 'Healthcare' } }] },
          { year: 2025, program_name: 'SE', project_disciplines: [{ disciplines: { name: 'AI' } }], project_industry_categories: [{ industry_categories: { name: 'Healthcare' } }] },
          { year: 2026, program_name: 'CS', project_disciplines: [{ disciplines: { name: 'Cloud' } }], project_industry_categories: [{ industry_categories: { name: 'Technology' } }] },
        ],
      },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const options = await repo.getProjectFilterOptions();

    expect(mockClient._executionLogs.length).toBe(1);

    const log = mockClient._executionLogs[0];
    expect(log.table).toBe('projects');
    expect(log.selectFields).toBe('year, program_name, project_disciplines(disciplines(name)), project_industry_categories(industry_categories(name))');
    expect(log.isCol).toBe('deleted_at');
    expect(log.isVal).toBeNull();
    expect(log.ranges[0]).toEqual({ from: 0, to: 499 });

    expect(options.years).toEqual(['2026', '2025']);
    expect(options.programs).toEqual(['CS', 'SE']);
    expect(options.disciplines).toEqual(['AI', 'Artificial Intelligence', 'Cloud']);
    expect(options.industries).toEqual(['Healthcare', 'Technology']);
  });

  it('performs two queries when first chunk is exactly 500 rows and second is partial', async () => {
    // First chunk: 500 rows (all year=2024, program=CS, discipline=AI)
    const firstChunk = Array.from({ length: 500 }, () => ({
      year: 2024,
      program_name: 'CS',
      project_disciplines: [{ disciplines: { name: 'AI' } }],
      project_industry_categories: [{ industry_categories: { name: 'Technology' } }],
    }));
    // Second chunk: 3 rows (new values)
    const secondChunk = [
      { year: 2025, program_name: 'SE', project_disciplines: [{ disciplines: { name: 'Cloud' } }], project_industry_categories: [{ industry_categories: { name: 'Healthcare' } }] },
      { year: 2026, program_name: 'ME', project_disciplines: [{ disciplines: { name: 'IoT' } }], project_industry_categories: [{ industry_categories: { name: 'Agriculture' } }] },
      { year: 2024, program_name: 'CS', project_disciplines: [{ disciplines: { name: 'AI' } }], project_industry_categories: [{ industry_categories: { name: 'Technology' } }] }, // duplicate — must be deduplicated
    ];

    const mockClient = createSequentialMockSupabaseClient([
      { data: firstChunk },
      { data: secondChunk },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const options = await repo.getProjectFilterOptions();

    expect(mockClient._executionLogs.length).toBe(2);

    // First chunk range: 0–499
    expect(mockClient._executionLogs[0].ranges[0]).toEqual({ from: 0, to: 499 });
    // Second chunk range: 500–999
    expect(mockClient._executionLogs[1].ranges[0]).toEqual({ from: 500, to: 999 });

    // Both chunks must select only lightweight project and taxonomy fields
    for (const log of mockClient._executionLogs) {
      expect(log.selectFields).toBe('year, program_name, project_disciplines(disciplines(name)), project_industry_categories(industry_categories(name))');
      expect(log.isCol).toBe('deleted_at');
      expect(log.isVal).toBeNull();
    }

    // Deduplication and sorting
    expect(options.years).toEqual(['2026', '2025', '2024']); // descending
    expect(options.programs).toEqual(['CS', 'ME', 'SE']);    // alphabetical
    expect(options.disciplines).toEqual(['AI', 'Cloud', 'IoT']); // alphabetical
    expect(options.industries).toEqual(['Agriculture', 'Healthcare', 'Technology']); // alphabetical
  });

  it('excludes soft-deleted rows from every filter-options chunk query', async () => {
    const mockClient = createSequentialMockSupabaseClient([
      { data: [{ year: 2026, program_name: 'CS', project_disciplines: [{ disciplines: { name: 'AI' } }], project_industry_categories: [{ industry_categories: { name: 'Technology' } }] }] },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    await repo.getProjectFilterOptions();

    const log = mockClient._executionLogs[0];
    expect(log.isCol).toBe('deleted_at');
    expect(log.isVal).toBeNull();
  });
});

describe('SupabaseProjectRepositoryCore public snapshot authority', () => {
  function map(row: Partial<DatabaseProjectRow>) {
    const repo = new SupabaseProjectRepositoryCore({} as never);
    return repo.mapDbToDomain({
      id: 'project-id', public_id: 'project-a', snapshots: [], ...row,
    });
  }

  it('pairs by exact project-scoped public URL and carries the database gallery position', () => {
    const first = 'https://example.com/project-a/first.png';
    const second = 'https://example.com/project-a/second.png';
    const project = map({
      snapshots: [first, second],
      media_assets: [
        { asset_type: 'snapshot_image', public_url: second, alt_text_public: 'Second.', gallery_position: 2, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: first, alt_text_public: 'First.', gallery_position: 1, is_public_approved: true },
      ],
    });

    expect(project.snapshotMedia).toEqual([
      { url: first, altText: 'First.', galleryPosition: 1 },
      { url: second, altText: 'Second.', galleryPosition: 2 },
    ]);
  });

  it('omits a duplicated public URL instead of selecting an ambiguous media authority', () => {
    const duplicated = 'https://example.com/project-a/duplicated.png';
    const project = map({
      snapshots: [duplicated],
      media_assets: [
        { asset_type: 'snapshot_image', public_url: duplicated, alt_text_public: 'First claim.', gallery_position: 1, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: duplicated, alt_text_public: 'Second claim.', gallery_position: 2, is_public_approved: true },
      ],
    });

    expect(project.snapshotMedia).toEqual([]);
  });

  it.each([
    [
      'invalid-alt then valid',
      [
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: null, gallery_position: 1, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: 'Valid claim.', gallery_position: 2, is_public_approved: true },
      ],
    ],
    [
      'valid then invalid-alt',
      [
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: 'Valid claim.', gallery_position: 2, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: null, gallery_position: 1, is_public_approved: true },
      ],
    ],
    [
      'invalid-position then valid',
      [
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: 'Malformed position.', gallery_position: null, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: 'Valid claim.', gallery_position: 2, is_public_approved: true },
      ],
    ],
    [
      'valid then invalid-position',
      [
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: 'Valid claim.', gallery_position: 2, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: 'https://example.com/project-a/shared.png', alt_text_public: 'Malformed position.', gallery_position: null, is_public_approved: true },
      ],
    ],
  ])('fails closed for duplicate authority with %s row order', (_label, mediaAssets) => {
    const duplicated = 'https://example.com/project-a/shared.png';
    const project = map({ snapshots: [duplicated], media_assets: mediaAssets });

    expect(project.snapshotMedia).toEqual([]);
  });

  it('fails closed when three public-approved rows claim the same snapshot URL', () => {
    const duplicated = 'https://example.com/project-a/three-claims.png';
    const project = map({
      snapshots: [duplicated],
      media_assets: [
        { asset_type: 'snapshot_image', public_url: duplicated, alt_text_public: null, gallery_position: 1, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: duplicated, alt_text_public: 'Valid claim.', gallery_position: 2, is_public_approved: true },
        { asset_type: 'snapshot_image', public_url: duplicated, alt_text_public: 'Third claim.', gallery_position: 3, is_public_approved: true },
      ],
    });

    expect(project.snapshotMedia).toEqual([]);
  });

  it('keeps URL authority project-scoped when another project claims the same URL', () => {
    const shared = 'https://example.com/shared-across-projects.png';
    const first = map({
      public_id: 'project-a', snapshots: [shared],
      media_assets: [
        { asset_type: 'snapshot_image', public_url: shared, alt_text_public: 'Project A.', gallery_position: 1, is_public_approved: true },
      ],
    });
    const second = map({
      public_id: 'project-b', snapshots: [shared],
      media_assets: [
        { asset_type: 'snapshot_image', public_url: shared, alt_text_public: 'Project B.', gallery_position: 2, is_public_approved: true },
      ],
    });

    expect(first.snapshotMedia).toEqual([{ url: shared, altText: 'Project A.', galleryPosition: 1 }]);
    expect(second.snapshotMedia).toEqual([{ url: shared, altText: 'Project B.', galleryPosition: 2 }]);
  });
});
