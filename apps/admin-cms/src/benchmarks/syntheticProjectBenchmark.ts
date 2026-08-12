import { performance } from 'node:perf_hooks';

import { Project } from '../domain/project';
import { AllowedSortField, PageSizeOption, ProjectListQuery, ProjectListResult, normalizeSearchInput } from '../domain/projectQuery';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { FeedValidationResult, validatePublicFeed } from '../feed/validatePublicFeed';
import { PublicFeedRecord } from '../domain/publicFeed';

export const SYNTHETIC_BENCHMARK_OPERATION_NAMES = [
  'keyword search',
  'filtering',
  'sorting',
  'pagination',
  'public-feed compilation',
  'feed-schema validation',
] as const;

export type SyntheticBenchmarkOperationName = (typeof SYNTHETIC_BENCHMARK_OPERATION_NAMES)[number];

export interface BenchmarkTimingSummary {
  operation: SyntheticBenchmarkOperationName;
  iterations: number;
  resultCount: number;
  minimumMs: number;
  medianMs: number;
  meanMs: number;
  p95Ms: number;
}

export interface SyntheticProjectBenchmarkOptions {
  seed?: number;
  warmupIterations?: number;
  iterations?: number;
  now?: () => number;
}

export interface SyntheticProjectBenchmarkReport {
  seed?: number;
  datasetSize: number;
  warmupIterations: number;
  timings: BenchmarkTimingSummary[];
}

function compareValues(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortValue(project: Project, field: AllowedSortField): string {
  return String(project[field] ?? '');
}

/**
 * In-memory equivalent of the repository's project list query. It intentionally accepts the
 * already parsed query shape so URL parsing and its validation remain production-owned.
 */
export function querySyntheticProjects(projects: Project[], query: ProjectListQuery = {}): ProjectListResult {
  const search = normalizeSearchInput(query.search).toLocaleLowerCase();
  const filtered = projects.filter((project) => {
    const matchesSearch = !search || [
      project.title,
      project.publicId ?? '',
      project.industryPartner,
      project.groupName,
    ].some((value) => value.toLocaleLowerCase().includes(search));

    if (!matchesSearch) return false;
    if (query.status !== undefined && project.status !== query.status) return false;
    if (query.year !== undefined && project.year !== query.year) return false;
    if (query.program !== undefined && project.program !== query.program) return false;
    if (query.discipline !== undefined && project.discipline !== query.discipline) return false;
    return true;
  });

  const sortField = query.sort ?? 'created_at';
  const direction = query.direction ?? 'desc';
  const sorted = [...filtered].sort((left, right) => {
    const primary = compareValues(sortValue(left, sortField), sortValue(right, sortField));
    const directed = direction === 'asc' ? primary : -primary;
    return directed || compareValues(left.publicId ?? '', right.publicId ?? '');
  });

  const pageSize = (query.pageSize ?? 10) as PageSizeOption;
  const requestedPage = Math.max(1, query.page ?? 1);
  const pageCount = sorted.length === 0 ? 0 : Math.ceil(sorted.length / pageSize);
  const page = pageCount === 0 ? requestedPage : Math.min(requestedPage, pageCount);
  const start = (page - 1) * pageSize;

  return {
    projects: sorted.slice(start, start + pageSize),
    total: sorted.length,
    page,
    pageSize,
    pageCount,
  };
}

function resultCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object') {
    const record = result as { projects?: unknown[]; valid?: boolean };
    if (Array.isArray(record.projects)) return record.projects.length;
    if (typeof record.valid === 'boolean') return record.valid ? 1 : 0;
  }
  return 1;
}

function resultChecksum(result: unknown): number {
  if (Array.isArray(result)) {
    return result.reduce((checksum, item, index) => {
      if (item && typeof item === 'object') {
        const record = item as { id?: unknown; publicId?: unknown };
        return checksum + Number(record.id ?? index) + String(record.publicId ?? '').length;
      }
      return checksum + index;
    }, 0);
  }

  if (result && typeof result === 'object') {
    const record = result as { projects?: unknown[]; valid?: boolean; errors?: unknown[]; warnings?: unknown[] };
    if (Array.isArray(record.projects)) return resultChecksum(record.projects);
    if (typeof record.valid === 'boolean') {
      return Number(record.valid) + (record.errors?.length ?? 0) + (record.warnings?.length ?? 0);
    }
  }

  return 1;
}

function percentile(sortedDurations: number[], percentileValue: number): number {
  const index = Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * percentileValue) - 1);
  return sortedDurations[index];
}

function measureOperation(
  operation: SyntheticBenchmarkOperationName,
  run: () => unknown,
  warmupIterations: number,
  iterations: number,
  now: () => number,
): BenchmarkTimingSummary {
  let lastResultCount = 0;
  let lastChecksum = 0;
  const execute = () => {
    const result = run();
    lastResultCount = resultCount(result);
    lastChecksum = resultChecksum(result);
  };

  for (let index = 0; index < warmupIterations; index += 1) execute();

  const durations: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = now();
    execute();
    durations.push(now() - startedAt);
  }

  // Keep the operation result live for the duration of the benchmark loop.
  if (lastChecksum === Number.MIN_SAFE_INTEGER) throw new Error('Synthetic benchmark checksum failure.');

  const sortedDurations = [...durations].sort((left, right) => left - right);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    operation,
    iterations,
    resultCount: lastResultCount,
    minimumMs: sortedDurations[0],
    medianMs: percentile(sortedDurations, 0.5),
    meanMs: total / durations.length,
    p95Ms: percentile(sortedDurations, 0.95),
  };
}

export function runSyntheticProjectBenchmark(
  projects: Project[],
  options: SyntheticProjectBenchmarkOptions = {},
): SyntheticProjectBenchmarkReport {
  const warmupIterations = options.warmupIterations ?? 3;
  const iterations = options.iterations ?? 25;
  const now = options.now ?? (() => performance.now());

  if (!Number.isInteger(warmupIterations) || warmupIterations < 0) {
    throw new Error('Benchmark warm-up iterations must be a non-negative integer.');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('Benchmark iterations must be a positive integer.');
  }

  const firstProject = projects[0];
  if (!firstProject) throw new Error('Cannot benchmark an empty synthetic project collection.');

  const compiledFeed = compilePublicFeed(projects);
  const feedValidation: FeedValidationResult = validatePublicFeed(compiledFeed);
  if (!feedValidation.valid) {
    throw new Error(`Generated benchmark feed is invalid: ${feedValidation.errors.join(' | ')}`);
  }

  const operations: Array<{ name: SyntheticBenchmarkOperationName; run: () => unknown }> = [
    {
      name: 'keyword search',
      run: () => querySyntheticProjects(projects, { search: 'Synthetic', pageSize: 10 }),
    },
    {
      name: 'filtering',
      run: () => querySyntheticProjects(projects, {
        status: firstProject.status,
        year: firstProject.year,
        program: firstProject.program,
        discipline: firstProject.discipline,
        pageSize: 10,
      }),
    },
    {
      name: 'sorting',
      run: () => querySyntheticProjects(projects, { sort: 'title', direction: 'asc', pageSize: 50 }),
    },
    {
      name: 'pagination',
      run: () => querySyntheticProjects(projects, { sort: 'title', direction: 'asc', page: 3, pageSize: 25 }),
    },
    {
      name: 'public-feed compilation',
      run: () => compilePublicFeed(projects),
    },
    {
      name: 'feed-schema validation',
      run: () => validatePublicFeed(compiledFeed),
    },
  ];

  return {
    seed: options.seed,
    datasetSize: projects.length,
    warmupIterations,
    timings: operations.map(({ name, run }) => measureOperation(name, run, warmupIterations, iterations, now)),
  };
}

export function formatSyntheticBenchmarkReport(report: SyntheticProjectBenchmarkReport): string {
  const lines = [
    `Synthetic project benchmark: ${report.datasetSize} projects`,
    `Seed: ${report.seed ?? 'unspecified'} | Warm-up iterations: ${report.warmupIterations}`,
    'Operation                         Results  Iterations  Min ms  Median ms  Mean ms  P95 ms',
  ];

  report.timings.forEach((timing) => {
    lines.push(
      `${timing.operation.padEnd(34)} ${String(timing.resultCount).padStart(7)} ${String(timing.iterations).padStart(11)} `
      + `${timing.minimumMs.toFixed(3).padStart(7)} ${timing.medianMs.toFixed(3).padStart(10)} `
      + `${timing.meanMs.toFixed(3).padStart(8)} ${timing.p95Ms.toFixed(3).padStart(7)}`,
    );
  });

  return lines.join('\n');
}

export type SyntheticBenchmarkFeed = PublicFeedRecord[];
