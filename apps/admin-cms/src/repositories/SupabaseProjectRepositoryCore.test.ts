import { describe, it, expect, vi } from 'vitest';
import { SupabaseProjectRepositoryCore } from './SupabaseProjectRepositoryCore';
import { ProjectListQuery, AllowedSortField } from '../domain/projectQuery';

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

describe('SupabaseProjectRepositoryCore query operations', () => {
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
          { year: 2026, program_name: 'CS', discipline: 'AI' },
          { year: 2025, program_name: 'SE', discipline: 'AI' },
          { year: 2026, program_name: 'CS', discipline: 'Cloud' },
        ],
      },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const options = await repo.getProjectFilterOptions();

    expect(mockClient._executionLogs.length).toBe(1);

    const log = mockClient._executionLogs[0];
    expect(log.table).toBe('projects');
    expect(log.selectFields).toBe('year, program_name, discipline');
    expect(log.isCol).toBe('deleted_at');
    expect(log.isVal).toBeNull();
    expect(log.ranges[0]).toEqual({ from: 0, to: 499 });

    expect(options.years).toEqual(['2026', '2025']);
    expect(options.programs).toEqual(['CS', 'SE']);
    expect(options.disciplines).toEqual(['AI', 'Cloud']);
  });

  it('performs two queries when first chunk is exactly 500 rows and second is partial', async () => {
    // First chunk: 500 rows (all year=2024, program=CS, discipline=AI)
    const firstChunk = Array.from({ length: 500 }, () => ({
      year: 2024,
      program_name: 'CS',
      discipline: 'AI',
    }));
    // Second chunk: 3 rows (new values)
    const secondChunk = [
      { year: 2025, program_name: 'SE', discipline: 'Cloud' },
      { year: 2026, program_name: 'ME', discipline: 'IoT' },
      { year: 2024, program_name: 'CS', discipline: 'AI' }, // duplicate — must be deduplicated
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

    // Both chunks must select only the three lightweight columns
    for (const log of mockClient._executionLogs) {
      expect(log.selectFields).toBe('year, program_name, discipline');
      expect(log.isCol).toBe('deleted_at');
      expect(log.isVal).toBeNull();
    }

    // Deduplication and sorting
    expect(options.years).toEqual(['2026', '2025', '2024']); // descending
    expect(options.programs).toEqual(['CS', 'ME', 'SE']);    // alphabetical
    expect(options.disciplines).toEqual(['AI', 'Cloud', 'IoT']); // alphabetical
  });

  it('excludes soft-deleted rows from every filter-options chunk query', async () => {
    const mockClient = createSequentialMockSupabaseClient([
      { data: [{ year: 2026, program_name: 'CS', discipline: 'AI' }] },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    await repo.getProjectFilterOptions();

    const log = mockClient._executionLogs[0];
    expect(log.isCol).toBe('deleted_at');
    expect(log.isVal).toBeNull();
  });
});
