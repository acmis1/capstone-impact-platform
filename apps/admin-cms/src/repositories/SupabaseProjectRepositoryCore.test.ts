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
          count: resp.count !== undefined ? resp.count : 0,
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

  it('clamps out-of-range requested page to final page with proper sequential re-query', async () => {
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
    expect(log.orClause).not.toContain('\'');
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

  it('counts inReview metrics strictly for status in_review only', async () => {
    const mockClient = createSequentialMockSupabaseClient([
      {
        data: [
          { status: 'approved' },
          { status: 'published' },
          { status: 'in_review' },
          { status: 'submitted' },
          { status: 'changes_requested' },
          { status: 'archived' },
        ],
      },
    ]);

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const metrics = await repo.getProjectDashboardMetrics();

    expect(metrics).toEqual({
      totalProjects: 6,
      publicEligible: 2, // approved + published
      inReview: 1,       // strictly in_review
      archived: 1,       // archived
    });
  });

  it('fetches distinct filter options without full project data', async () => {
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

    const log = mockClient._executionLogs[0];
    expect(log.selectFields).toBe('year, program_name, discipline');
    expect(options.years).toEqual(['2026', '2025']);
    expect(options.programs).toEqual(['CS', 'SE']);
    expect(options.disciplines).toEqual(['AI', 'Cloud']);
  });
});
