import { describe, it, expect, vi } from 'vitest';
import { SupabaseProjectRepositoryCore } from './SupabaseProjectRepositoryCore';
import { ProjectListQuery } from '../domain/projectQuery';

function createMockSupabaseClient() {
  const queryState: Record<string, unknown> = {};

  const builder: Record<string, unknown> = {
    select: vi.fn().mockImplementation((fields, opts) => {
      queryState.selectFields = fields;
      queryState.selectOpts = opts;
      return builder;
    }),
    is: vi.fn().mockImplementation((col, val) => {
      queryState.isCol = col;
      queryState.isVal = val;
      return builder;
    }),
    or: vi.fn().mockImplementation((clause) => {
      queryState.orClause = clause;
      return builder;
    }),
    eq: vi.fn().mockImplementation((col, val) => {
      if (!queryState.eqFilters) queryState.eqFilters = {};
      (queryState.eqFilters as Record<string, unknown>)[col] = val;
      return builder;
    }),
    order: vi.fn().mockImplementation((col, opts) => {
      queryState.orderCol = col;
      queryState.orderOpts = opts;
      return builder;
    }),
    range: vi.fn().mockImplementation((from, to) => {
      queryState.rangeFrom = from;
      queryState.rangeTo = to;
      return builder;
    }),
    then: vi.fn().mockImplementation((resolve) => {
      resolve({
        data: queryState.mockData || [],
        count: queryState.mockCount !== undefined ? queryState.mockCount : 0,
        error: null,
      });
    }),
  };

  const client = {
    from: vi.fn().mockImplementation((table) => {
      queryState.table = table;
      return builder;
    }),
    _queryState: queryState,
    _builder: builder,
  };

  return client as unknown as import('@supabase/supabase-js').SupabaseClient & { _queryState: Record<string, unknown> };
}

describe('SupabaseProjectRepositoryCore query operations', () => {
  it('applies is("deleted_at", null) and range 0-9 for page 1 / pageSize 10', async () => {
    const mockClient = createMockSupabaseClient();
    mockClient._queryState.mockData = [
      { id: 'uuid-1', public_id: '2026-proj1', title: 'Proj 1', status: 'approved' },
    ];
    mockClient._queryState.mockCount = 1;

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = { page: 1, pageSize: 10, sort: 'created_at', direction: 'desc' };

    const result = await repo.listProjectsPage(query);

    expect(mockClient._queryState.table).toBe('projects');
    expect(mockClient._queryState.isCol).toBe('deleted_at');
    expect(mockClient._queryState.isVal).toBeNull();
    expect(mockClient._queryState.rangeFrom).toBe(0);
    expect(mockClient._queryState.rangeTo).toBe(9);
    expect(result.total).toBe(1);
    expect(result.projects.length).toBe(1);
  });

  it('calculates range 25-49 for page 2 / pageSize 25', async () => {
    const mockClient = createMockSupabaseClient();
    mockClient._queryState.mockData = [];
    mockClient._queryState.mockCount = 50;

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = { page: 2, pageSize: 25, sort: 'year', direction: 'asc' };

    await repo.listProjectsPage(query);

    expect(mockClient._queryState.rangeFrom).toBe(25);
    expect(mockClient._queryState.rangeTo).toBe(49);
    expect(mockClient._queryState.orderCol).toBe('year');
    expect(mockClient._queryState.orderOpts).toEqual({ ascending: true });
  });

  it('maps filters status, year, program, discipline correctly to columns', async () => {
    const mockClient = createMockSupabaseClient();
    mockClient._queryState.mockData = [];
    mockClient._queryState.mockCount = 0;

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const query: ProjectListQuery = {
      status: 'in_review',
      year: '2026',
      program: 'Software Engineering',
      discipline: 'AI',
      page: 1,
      pageSize: 10,
    };

    await repo.listProjectsPage(query);

    expect(mockClient._queryState.eqFilters).toEqual({
      status: 'in_review',
      year: 2026,
      program_name: 'Software Engineering',
      discipline: 'AI',
    });
  });

  it('counts inReview metrics strictly for status in_review only', async () => {
    const mockClient = createMockSupabaseClient();
    mockClient._queryState.mockData = [
      { status: 'approved' },
      { status: 'published' },
      { status: 'in_review' },
      { status: 'submitted' },
      { status: 'changes_requested' },
      { status: 'archived' },
    ];

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
    const mockClient = createMockSupabaseClient();
    mockClient._queryState.mockData = [
      { year: 2026, program_name: 'CS', discipline: 'AI' },
      { year: 2025, program_name: 'SE', discipline: 'AI' },
      { year: 2026, program_name: 'CS', discipline: 'Cloud' },
    ];

    const repo = new SupabaseProjectRepositoryCore(mockClient);
    const options = await repo.getProjectFilterOptions();

    expect(mockClient._queryState.selectFields).toBe('year, program_name, discipline');
    expect(options.years).toEqual(['2026', '2025']);
    expect(options.programs).toEqual(['CS', 'SE']);
    expect(options.disciplines).toEqual(['AI', 'Cloud']);
  });
});
