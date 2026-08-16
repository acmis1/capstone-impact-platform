import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Project } from '../domain/project';
import {
  ProjectDashboardMetrics,
  ProjectFilterOptions,
  ProjectListResult,
} from '../domain/projectQuery';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { generateSyntheticProjects } from '../fixtures/syntheticProjects';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import {
  BENCHMARK_STORAGE_EXTENSION,
  BENCHMARK_STORAGE_MIME_TYPE,
  BENCHMARK_STORAGE_SIZES,
  DatabaseBenchmarkResult,
  LocalScalingReport,
  SeedBenchmarkResult,
  StorageBenchmarkResult,
  SyntheticProjectCount,
  calculateTimingSummary,
  calculateThroughput,
} from './scalingBenchmarkTypes';
import {
  adaptSyntheticProjectForDb,
  createDeterministicStoragePayload,
} from './localScalingFixtureAdapter';

export interface LocalScalingRunnerOptions {
  apiUrl: string;
  serviceRoleKey: string;
  datasetSize?: SyntheticProjectCount;
  seed?: number;
  warmupIterations?: number;
  measuredIterations?: number;
}

export interface RunLocalScalingResult {
  report: LocalScalingReport;
  success: boolean;
  errors: string[];
}

export interface CleanupOperationResult<T> {
  data: T;
  error?: unknown;
}

export interface CleanupDependencies {
  findVerifierProjectIds(): Promise<CleanupOperationResult<string[]>>;
  deleteVerifierMedia(projectIds: string[]): Promise<CleanupOperationResult<number>>;
  deleteVerifierProjects(projectIds: string[]): Promise<CleanupOperationResult<number>>;
  countVerifierProjects(): Promise<CleanupOperationResult<number>>;
  listVerifierStorage(): Promise<CleanupOperationResult<string[]>>;
  removeVerifierStorage(paths: string[]): Promise<CleanupOperationResult<number>>;
}

export interface CleanupEvidence {
  projectDeletionAttempted: boolean;
  mediaAssetDeletionAttempted: boolean;
  storageDeletionAttempted: boolean;
  projectsRemoved: number;
  mediaAssetsRemoved: number;
  storageObjectsRemoved: number;
  residualVerifierProjects: number | null;
  residualVerifierStorageObjects: number | null;
  errors: string[];
  clean: boolean;
}

const STORAGE_BUCKET = 'project-drafts-private';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function requireSuccessful<T>(result: CleanupOperationResult<T>, operation: string): T {
  if (result.error) throw new Error(`${operation}: ${errorMessage(result.error)}`);
  return result.data;
}

/** Runs all safe verifier-owned cleanup steps and fails closed if any evidence is unavailable. */
export async function cleanupVerifierArtifacts(
  dependencies: CleanupDependencies,
): Promise<CleanupEvidence> {
  const errors: string[] = [];
  let verifierIds: string[] | null = null;
  let projectDeletionAttempted = false;
  let mediaAssetDeletionAttempted = false;
  let storageDeletionAttempted = false;
  let projectsRemoved = 0;
  let mediaAssetsRemoved = 0;
  let storageObjectsRemoved = 0;
  let residualVerifierProjects: number | null = null;
  let residualVerifierStorageObjects: number | null = null;

  try {
    verifierIds = requireSuccessful(
      await dependencies.findVerifierProjectIds(),
      'Finding verifier-owned projects failed',
    );
  } catch (error) {
    errors.push(errorMessage(error));
  }

  if (verifierIds && verifierIds.length > 0) {
    mediaAssetDeletionAttempted = true;
    try {
      mediaAssetsRemoved = requireSuccessful(
        await dependencies.deleteVerifierMedia(verifierIds),
        'Deleting verifier-owned media assets failed',
      );
    } catch (error) {
      errors.push(errorMessage(error));
    }

    projectDeletionAttempted = true;
    try {
      projectsRemoved = requireSuccessful(
        await dependencies.deleteVerifierProjects(verifierIds),
        'Deleting verifier-owned projects failed',
      );
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  try {
    residualVerifierProjects = requireSuccessful(
      await dependencies.countVerifierProjects(),
      'Post-delete verifier project residue query failed',
    );
  } catch (error) {
    errors.push(errorMessage(error));
  }

  let storagePaths: string[] | null = null;
  try {
    storagePaths = requireSuccessful(
      await dependencies.listVerifierStorage(),
      'Listing verifier-owned Storage objects failed',
    );
  } catch (error) {
    errors.push(errorMessage(error));
  }

  if (storagePaths && storagePaths.length > 0) {
    storageDeletionAttempted = true;
    try {
      storageObjectsRemoved = requireSuccessful(
        await dependencies.removeVerifierStorage(storagePaths),
        'Removing verifier-owned Storage objects failed',
      );
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  try {
    const finalStoragePaths = requireSuccessful(
      await dependencies.listVerifierStorage(),
      'Final verifier Storage residue listing failed',
    );
    residualVerifierStorageObjects = finalStoragePaths.length;
  } catch (error) {
    errors.push(errorMessage(error));
  }

  const clean = errors.length === 0
    && residualVerifierProjects === 0
    && residualVerifierStorageObjects === 0;

  return {
    projectDeletionAttempted,
    mediaAssetDeletionAttempted,
    storageDeletionAttempted,
    projectsRemoved,
    mediaAssetsRemoved,
    storageObjectsRemoved,
    residualVerifierProjects,
    residualVerifierStorageObjects,
    errors,
    clean,
  };
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Correctness assertion failed: ${message}`);
}

function assertScopedProjects(result: ProjectListResult, expectedIds: Set<string>, label: string): void {
  assertCondition(
    result.projects.every((project) => project.publicId && expectedIds.has(project.publicId)),
    `${label} returned a project outside the verifier namespace`,
  );
}

export function assertSorted(
  projects: Project[],
  value: (project: Project) => string | number,
  direction: 'asc' | 'desc',
  label: string,
): void {
  for (let index = 1; index < projects.length; index++) {
    const previous = projects[index - 1];
    const current = projects[index];
    const previousValue = value(previous);
    const currentValue = value(current);
    const primaryOrder = previousValue < currentValue ? -1 : previousValue > currentValue ? 1 : 0;
    const expectedOrder = direction === 'asc' ? primaryOrder <= 0 : primaryOrder >= 0;
    assertCondition(expectedOrder, `${label} primary ordering is incorrect`);
    if (primaryOrder === 0) {
      assertCondition(
        (previous.publicId || '') <= (current.publicId || ''),
        `${label} public_id tie-break ordering is incorrect`,
      );
    }
  }
}

export function countSearchMatches(projects: Project[], search: string): number {
  const normalized = search.toLocaleLowerCase();
  return projects.filter((project) => [
    project.title,
    project.publicId || '',
    project.industryPartner,
    project.groupName,
  ].some((value) => value.toLocaleLowerCase().includes(normalized))).length;
}

export function assertDashboardDelta(
  baseline: ProjectDashboardMetrics,
  postSeed: ProjectDashboardMetrics,
  syntheticProjects: Project[],
): void {
  const expected = {
    totalProjects: baseline.totalProjects + syntheticProjects.length,
    publicEligible: baseline.publicEligible
      + syntheticProjects.filter((project) => ['approved', 'published'].includes(project.status)).length,
    inReview: baseline.inReview
      + syntheticProjects.filter((project) => project.status === 'in_review').length,
    archived: baseline.archived
      + syntheticProjects.filter((project) => project.status === 'archived').length,
  };
  assertCondition(
    JSON.stringify(postSeed) === JSON.stringify(expected),
    `dashboard metrics did not equal baseline plus synthetic status deltas (expected ${JSON.stringify(expected)}, got ${JSON.stringify(postSeed)})`,
  );
}

export function assertFilterOptions(
  baseline: ProjectFilterOptions,
  postSeed: ProjectFilterOptions,
  syntheticProjects: Project[],
): void {
  const checks: Array<[keyof ProjectFilterOptions, string[]]> = [
    ['years', syntheticProjects.map((project) => project.year)],
    ['programs', syntheticProjects.map((project) => project.program)],
    ['disciplines', syntheticProjects.map((project) => project.discipline)],
  ];
  for (const [key, expectedSyntheticValues] of checks) {
    const postValues = new Set(postSeed[key]);
    assertCondition(
      expectedSyntheticValues.every((value) => postValues.has(value)),
      `filter options omitted a synthetic ${key} value`,
    );
    assertCondition(
      baseline[key].every((value) => postValues.has(value)),
      `filter options lost a baseline ${key} value`,
    );
  }
}

function createCleanupDependencies(
  supabase: SupabaseClient,
  runPrefix: string,
  storagePrefix: string,
): CleanupDependencies {
  return {
    async findVerifierProjectIds() {
      const result = await supabase
        .from('projects')
        .select('id')
        .like('public_id', `${runPrefix}-%`);
      return {
        data: (result.data || []).map((project: { id: string }) => project.id),
        error: result.error || (result.data === null ? new Error('Project lookup returned no deletion evidence.') : undefined),
      };
    },
    async deleteVerifierMedia(projectIds) {
      const result = await supabase
        .from('media_assets')
        .delete()
        .in('project_id', projectIds)
        .select('id');
      return {
        data: (result.data || []).length,
        error: result.error || (result.data === null ? new Error('Media deletion returned no confirmation data.') : undefined),
      };
    },
    async deleteVerifierProjects(projectIds) {
      const result = await supabase
        .from('projects')
        .delete()
        .in('id', projectIds)
        .select('id');
      const removed = (result.data || []).length;
      return {
        data: removed,
        error: result.error
          || (result.data === null ? new Error('Project deletion returned no confirmation data.') : undefined)
          || (removed !== projectIds.length ? new Error(`Project deletion confirmed ${removed} of ${projectIds.length} rows.`) : undefined),
      };
    },
    async countVerifierProjects() {
      const result = await supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .like('public_id', `${runPrefix}-%`);
      return {
        data: result.count ?? 0,
        error: result.error || (result.count === null ? new Error('Project residue count was unavailable.') : undefined),
      };
    },
    async listVerifierStorage() {
      const result = await supabase.storage.from(STORAGE_BUCKET).list(storagePrefix);
      return {
        data: (result.data || []).map((file) => `${storagePrefix}/${file.name}`),
        error: result.error || (result.data === null ? new Error('Storage listing returned no evidence.') : undefined),
      };
    },
    async removeVerifierStorage(paths) {
      const result = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
      const removed = (result.data || []).length;
      return {
        data: removed,
        error: result.error
          || (result.data === null ? new Error('Storage removal returned no confirmation data.') : undefined)
          || (removed !== paths.length ? new Error(`Storage removal confirmed ${removed} of ${paths.length} objects.`) : undefined),
      };
    },
  };
}

export async function runLocalScalingVerification(
  options: LocalScalingRunnerOptions,
): Promise<RunLocalScalingResult> {
  const errors: string[] = [];
  const {
    apiUrl,
    serviceRoleKey,
    datasetSize = 100,
    seed = 0xD4072026,
    warmupIterations = 2,
    measuredIterations = 5,
  } = options;

  if (!isLoopbackUrl(apiUrl)) {
    throw new Error(
      `Security violation: Benchmark target URL [${apiUrl}] is not a loopback address. Only local Disposable Supabase is permitted.`,
    );
  }
  if (!Number.isInteger(warmupIterations) || warmupIterations < 0) {
    throw new Error('Warmup iterations must be a non-negative integer.');
  }
  if (!Number.isInteger(measuredIterations) || measuredIterations < 1) {
    throw new Error('Measured iterations must be a positive integer.');
  }

  const supabase: SupabaseClient = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const runId = randomUUID().replaceAll('-', '').slice(0, 10);
  const runPrefix = `scalebench-${runId}`;
  const storagePrefix = `performance-verification/${runId}`;
  const repository = new SupabaseProjectRepositoryCore(supabase);

  const emptyMetrics: ProjectDashboardMetrics = {
    totalProjects: 0,
    publicEligible: 0,
    inReview: 0,
    archived: 0,
  };
  const emptyOptions: ProjectFilterOptions = { years: [], programs: [], disciplines: [] };
  let baselineDashboard = emptyMetrics;
  let postSeedDashboard = emptyMetrics;
  let baselineFilterOptions = emptyOptions;
  let baselineProjects: Project[] = [];
  let baselineVerifierProjects = 0;
  let baselineStorageObjects = 0;
  let postSeedTotalProjects = 0;
  let postSeedPublishedProjects = 0;
  let syntheticPublishedProjects = 0;
  let seedResult: SeedBenchmarkResult = { projectCount: 0, durationMs: 0, projectsPerSecond: 0 };
  const dbResults: DatabaseBenchmarkResult[] = [];
  const storageResults: StorageBenchmarkResult[] = [];
  let projectsInsertedCount = 0;
  let mediaAssetsInsertedCount = 0;
  let storageObjectsCreated = 0;
  let inlineStorageObjectsRemoved = 0;

  try {
    const baselineVerifierResult = await supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .like('public_id', `${runPrefix}-%`);
    if (baselineVerifierResult.error || baselineVerifierResult.count === null) {
      throw new Error(`Baseline verifier project query failed: ${baselineVerifierResult.error?.message || 'exact count unavailable'}`);
    }
    baselineVerifierProjects = baselineVerifierResult.count ?? 0;

    const baselineStorageResult = await supabase.storage.from(STORAGE_BUCKET).list(storagePrefix);
    if (baselineStorageResult.error || baselineStorageResult.data === null) {
      throw new Error(`Baseline verifier Storage listing failed: ${baselineStorageResult.error?.message || 'listing unavailable'}`);
    }
    baselineStorageObjects = (baselineStorageResult.data || []).length;
    assertCondition(
      baselineVerifierProjects === 0 && baselineStorageObjects === 0,
      'fresh random verifier namespace was not empty before seeding',
    );

    [baselineDashboard, baselineFilterOptions, baselineProjects] = await Promise.all([
      repository.getProjectDashboardMetrics(),
      repository.getProjectFilterOptions(),
      repository.listProjects(),
    ]);
    assertCondition(
      baselineProjects.length === baselineDashboard.totalProjects,
      'baseline repository population did not match dashboard total',
    );

    const baselineSearchTotals = new Map<string, number>();
    for (const search of ['Signal', 'Mapping']) {
      baselineSearchTotals.set(search, (await repository.listProjectsPage({ search, pageSize: 10 })).total);
    }

    const syntheticProjects = generateSyntheticProjects({ count: datasetSize, seed });
    const adapted = syntheticProjects.map((project) => adaptSyntheticProjectForDb(project, runPrefix));
    const scopedSyntheticProjects = syntheticProjects.map((project) => ({
      ...project,
      publicId: `${runPrefix}-${project.publicId}`,
    }));
    const expectedIds = new Set(scopedSyntheticProjects.map((project) => project.publicId as string));
    syntheticPublishedProjects = scopedSyntheticProjects.filter((project) => project.status === 'published').length;

    const seedStart = performance.now();
    const batchSize = 25;
    for (let index = 0; index < adapted.length; index += batchSize) {
      const batch = adapted.slice(index, index + batchSize);
      const projectInsert = await supabase
        .from('projects')
        .insert(batch.map((item) => item.projectRow))
        .select('id, public_id');
      if (projectInsert.error || !projectInsert.data) {
        throw new Error(`Failed to seed batch of synthetic projects: ${projectInsert.error?.message || 'missing inserted rows'}`);
      }
      projectsInsertedCount += projectInsert.data.length;

      const idByPublicId = new Map<string, string>();
      projectInsert.data.forEach((row: { id: string; public_id: string }) => {
        idByPublicId.set(row.public_id, row.id);
      });
      const mediaRows = batch.flatMap((item) => item.mediaRows.map((media) => ({
        ...media,
        project_id: idByPublicId.get(String(item.projectRow.public_id)),
      })));
      if (mediaRows.length > 0) {
        const mediaInsert = await supabase.from('media_assets').insert(mediaRows).select('id');
        if (mediaInsert.error || !mediaInsert.data) {
          throw new Error(`Failed to seed media assets for synthetic batch: ${mediaInsert.error?.message || 'missing inserted rows'}`);
        }
        mediaAssetsInsertedCount += mediaInsert.data.length;
      }
    }

    const seedDurationMs = Number((performance.now() - seedStart).toFixed(2));
    seedResult = {
      projectCount: projectsInsertedCount,
      durationMs: seedDurationMs,
      projectsPerSecond: Number(((projectsInsertedCount / (seedDurationMs / 1000)) || 0).toFixed(1)),
    };
    assertCondition(projectsInsertedCount === datasetSize, `seed inserted ${projectsInsertedCount}, expected ${datasetSize}`);

    interface QueryOperation {
      operation: string;
      category: DatabaseBenchmarkResult['category'];
      run: () => Promise<unknown> | unknown;
      count: (result: unknown) => number;
      validate: (result: unknown) => void;
    }

    const asPage = (result: unknown) => result as ProjectListResult;
    const asProjects = (result: unknown) => result as Project[];
    let feedProjects: Project[] = [];
    let compiledFeed = compilePublicFeed([]);

    const pageOperation = (
      operation: string,
      category: DatabaseBenchmarkResult['category'],
      query: Parameters<SupabaseProjectRepositoryCore['listProjectsPage']>[0],
      validate: (result: ProjectListResult) => void,
    ): QueryOperation => ({
      operation,
      category,
      run: () => repository.listProjectsPage(query),
      count: (result) => asPage(result).projects.length,
      validate: (result) => validate(asPage(result)),
    });

    const queryOperations: QueryOperation[] = [
      pageOperation('Pagination (Page 1, Size 10)', 'pagination', { search: runPrefix, page: 1, pageSize: 10 }, (result) => {
        assertCondition(result.page === 1 && result.projects.length === 10 && result.total === datasetSize, 'page 1 size 10 was not exact');
        assertScopedProjects(result, expectedIds, 'page 1 size 10');
      }),
      pageOperation('Pagination (Page 1, Size 50)', 'pagination', { search: runPrefix, page: 1, pageSize: 50 }, (result) => {
        assertCondition(result.page === 1 && result.projects.length === 50 && result.total === datasetSize, 'page 1 size 50 was not exact');
        assertScopedProjects(result, expectedIds, 'page 1 size 50');
      }),
      pageOperation('Pagination (Page 5, Size 10)', 'pagination', { search: runPrefix, page: 5, pageSize: 10 }, (result) => {
        assertCondition(result.page === 5 && result.projects.length === 10 && result.total === datasetSize, 'later page size 10 was not exact');
        assertScopedProjects(result, expectedIds, 'page 5 size 10');
      }),
      ...['Signal', 'Mapping'].map((search) => pageOperation(
        `Search ("${search}"; Baseline Delta)`,
        'search',
        { search, pageSize: 10 },
        (result) => {
          const expectedTotal = (baselineSearchTotals.get(search) || 0)
            + countSearchMatches(scopedSyntheticProjects, search);
          assertCondition(result.total === expectedTotal, `${search} search did not equal baseline plus exact synthetic delta`);
          const benchmarkRows = result.projects.filter((project) => project.publicId?.startsWith(`${runPrefix}-`));
          assertCondition(
            benchmarkRows.every((project) => countSearchMatches([project], search) === 1),
            `${search} search included an unrelated benchmark record`,
          );
        },
      )),
      pageOperation('Search (Run Public ID Prefix)', 'search', { search: runPrefix, pageSize: 50 }, (result) => {
        assertCondition(result.total === datasetSize && result.projects.length === 50, 'run-prefix search did not return the exact synthetic population');
        assertScopedProjects(result, expectedIds, 'run-prefix search');
      }),
      pageOperation('Filter (Year 2026)', 'filtering', { year: '2026', search: runPrefix, pageSize: 10 }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.year === '2026');
        assertCondition(result.total === expected.length && result.projects.every((project) => project.year === '2026'), 'year filtering was incorrect');
        assertScopedProjects(result, expectedIds, 'year filter');
      }),
      pageOperation('Filter (Status Published)', 'filtering', { status: 'published', search: runPrefix, pageSize: 10 }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.status === 'published');
        assertCondition(result.total === expected.length && result.projects.every((project) => project.status === 'published'), 'status filtering was incorrect');
        assertScopedProjects(result, expectedIds, 'status filter');
      }),
      pageOperation('Filter (Year 2026 + Published)', 'filtering', { year: '2026', status: 'published', search: runPrefix, pageSize: 10 }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.year === '2026' && project.status === 'published');
        assertCondition(result.total === expected.length && result.projects.every((project) => project.year === '2026' && project.status === 'published'), 'combined year/status filtering was incorrect');
        assertScopedProjects(result, expectedIds, 'combined year/status filter');
      }),
      pageOperation('Filter (Program + Discipline)', 'filtering', {
        program: 'Synthetic Software Systems',
        discipline: 'Synthetic Software Engineering',
        search: runPrefix,
        pageSize: 10,
      }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.program === 'Synthetic Software Systems' && project.discipline === 'Synthetic Software Engineering');
        assertCondition(result.total === expected.length && result.projects.every((project) => project.program === 'Synthetic Software Systems' && project.discipline === 'Synthetic Software Engineering'), 'program/discipline filtering was incorrect');
        assertScopedProjects(result, expectedIds, 'program/discipline filter');
      }),
      pageOperation('Sort (Created At Descending)', 'sorting', { search: runPrefix, sort: 'created_at', direction: 'desc', pageSize: 10 }, (result) => {
        assertCondition(result.total === datasetSize && result.projects.length === 10, 'created_at sort population was incorrect');
        assertScopedProjects(result, expectedIds, 'created_at sort');
        assertSorted(result.projects, (project) => project.created_at || '', 'desc', 'created_at sort');
      }),
      pageOperation('Sort (Title Ascending)', 'sorting', { search: runPrefix, sort: 'title', direction: 'asc', pageSize: 10 }, (result) => {
        assertCondition(result.total === datasetSize && result.projects.length === 10, 'title sort population was incorrect');
        assertScopedProjects(result, expectedIds, 'title sort');
        assertSorted(result.projects, (project) => project.title, 'asc', 'title sort');
      }),
      pageOperation('Sort (Year Descending)', 'sorting', { search: runPrefix, sort: 'year', direction: 'desc', pageSize: 10 }, (result) => {
        assertCondition(result.total === datasetSize && result.projects.length === 10, 'year sort population was incorrect');
        assertScopedProjects(result, expectedIds, 'year sort');
        assertSorted(result.projects, (project) => Number(project.year), 'desc', 'year sort');
      }),
      {
        operation: 'Dashboard Metrics (Total Local Population)',
        category: 'metrics',
        run: () => repository.getProjectDashboardMetrics(),
        count: (result) => (result as ProjectDashboardMetrics).totalProjects,
        validate: (result) => {
          postSeedDashboard = result as ProjectDashboardMetrics;
          assertDashboardDelta(baselineDashboard, postSeedDashboard, scopedSyntheticProjects);
        },
      },
      {
        operation: 'Filter Options Retrieval (Total Local Population)',
        category: 'filter-options',
        run: () => repository.getProjectFilterOptions(),
        count: (result) => {
          const optionsResult = result as ProjectFilterOptions;
          return optionsResult.years.length + optionsResult.programs.length + optionsResult.disciplines.length;
        },
        validate: (result) => assertFilterOptions(baselineFilterOptions, result as ProjectFilterOptions, scopedSyntheticProjects),
      },
      {
        operation: 'Feed DB Retrieval (Total Local Projects)',
        category: 'feed-query',
        run: () => repository.listProjects(),
        count: (result) => asProjects(result).length,
        validate: (result) => {
          feedProjects = asProjects(result);
          postSeedTotalProjects = feedProjects.length;
          assertCondition(feedProjects.length === baselineProjects.length + datasetSize, 'feed DB retrieval did not equal baseline plus synthetic population');
          const retrievedIds = new Set(feedProjects.map((project) => project.publicId));
          assertCondition([...expectedIds].every((id) => retrievedIds.has(id)), 'feed DB retrieval omitted a benchmark project');
        },
      },
      {
        operation: 'Public Feed Compilation (Total Local Published)',
        category: 'feed-compile',
        run: () => compilePublicFeed(feedProjects),
        count: (result) => (result as ReturnType<typeof compilePublicFeed>).length,
        validate: (result) => {
          compiledFeed = result as ReturnType<typeof compilePublicFeed>;
          postSeedPublishedProjects = compiledFeed.length;
          const expectedPublishedTotal = baselineProjects.filter((project) => project.status === 'published').length
            + syntheticPublishedProjects;
          assertCondition(compiledFeed.length === expectedPublishedTotal, 'compiled feed did not equal baseline plus synthetic published delta');
          const syntheticFeedIds = compiledFeed
            .filter((record) => record.publicId.startsWith(`${runPrefix}-`))
            .map((record) => record.publicId);
          assertCondition(
            syntheticFeedIds.length === syntheticPublishedProjects
              && syntheticFeedIds.every((id) => expectedIds.has(id)),
            'compiled feed synthetic contribution was incorrect',
          );
        },
      },
      {
        operation: 'Public Feed Schema Validation',
        category: 'feed-validation',
        run: () => validatePublicFeed(compiledFeed),
        count: () => compiledFeed.length,
        validate: (result) => {
          const validation = result as ReturnType<typeof validatePublicFeed>;
          assertCondition(validation.valid, `compiled Local feed failed schema validation: ${validation.errors.join(' | ')}`);
          const syntheticFeed = compiledFeed.filter((record) => record.publicId.startsWith(`${runPrefix}-`));
          const syntheticValidation = validatePublicFeed(syntheticFeed);
          assertCondition(syntheticValidation.valid, `benchmark-generated feed contribution failed schema validation: ${syntheticValidation.errors.join(' | ')}`);
        },
      },
    ];

    for (const operation of queryOperations) {
      for (let warmup = 0; warmup < warmupIterations; warmup++) {
        const warmupResult = await operation.run();
        operation.validate(warmupResult);
      }
      const durations: number[] = [];
      let resultCount = 0;
      for (let iteration = 0; iteration < measuredIterations; iteration++) {
        const start = performance.now();
        const result = await operation.run();
        durations.push(performance.now() - start);
        operation.validate(result);
        resultCount = operation.count(result);
      }
      dbResults.push({
        operation: operation.operation,
        category: operation.category,
        iterations: measuredIterations,
        resultCount,
        timings: calculateTimingSummary(durations),
      });
    }

    for (const sizeSpec of BENCHMARK_STORAGE_SIZES) {
      const payload = createDeterministicStoragePayload(sizeSpec.bytes, `${runId}_${sizeSpec.label}`);
      const storagePath = `${storagePrefix}/payload-${sizeSpec.label.replace(/\s+/g, '')}.${BENCHMARK_STORAGE_EXTENSION}`;
      const uploadStart = performance.now();
      const uploadResult = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, payload.buffer, {
        contentType: BENCHMARK_STORAGE_MIME_TYPE,
        upsert: false,
      });
      const uploadDurationMs = Number((performance.now() - uploadStart).toFixed(2));
      if (uploadResult.error) {
        throw new Error(`Storage upload failed for ${sizeSpec.label}: ${uploadResult.error.message}`);
      }
      storageObjectsCreated++;

      const downloadStart = performance.now();
      const downloadResult = await supabase.storage.from(STORAGE_BUCKET).download(storagePath);
      const downloadDurationMs = Number((performance.now() - downloadStart).toFixed(2));
      if (downloadResult.error || !downloadResult.data) {
        throw new Error(`Storage download failed for ${sizeSpec.label}: ${downloadResult.error?.message || 'empty response'}`);
      }
      const downloadedBuffer = Buffer.from(await downloadResult.data.arrayBuffer());
      const downloadedSha256 = createHash('sha256').update(downloadedBuffer).digest('hex');
      const integrityVerified = downloadedBuffer.length === payload.sizeBytes
        && downloadedSha256 === payload.sha256;
      assertCondition(integrityVerified, `Storage payload ${sizeSpec.label} failed byte length or SHA-256 verification`);

      storageResults.push({
        sizeLabel: sizeSpec.label,
        sizeBytes: sizeSpec.bytes,
        uploadDurationMs,
        uploadThroughputMibPerSec: calculateThroughput(sizeSpec.bytes, uploadDurationMs),
        downloadDurationMs,
        downloadThroughputMibPerSec: calculateThroughput(sizeSpec.bytes, downloadDurationMs),
        integrityVerified,
        sha256: downloadedSha256,
      });

      const removeResult = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
      if (removeResult.error || (removeResult.data || []).length !== 1) {
        throw new Error(`Storage inline remove failed for ${sizeSpec.label}: ${removeResult.error?.message || 'object removal was not confirmed'}`);
      }
      inlineStorageObjectsRemoved++;
    }
  } catch (error) {
    errors.push(errorMessage(error));
  } finally {
    const cleanup = await cleanupVerifierArtifacts(
      createCleanupDependencies(supabase, runPrefix, storagePrefix),
    );
    errors.push(...cleanup.errors.map((message) => `Cleanup error: ${message}`));

    const report: LocalScalingReport = {
      timestamp: new Date().toISOString(),
      datasetSize,
      seed,
      environment: 'Local Supabase (loopback)',
      population: {
        baselineTotalProjects: baselineDashboard.totalProjects,
        postSeedTotalProjects,
        baselinePublishedProjects: baselineProjects.filter((project) => project.status === 'published').length,
        postSeedPublishedProjects,
        syntheticPublishedProjects,
        baselineVerifierProjects,
        baselineStorageObjects,
        baselineDashboard,
        postSeedDashboard,
        baselineFilterOptions,
      },
      seeding: seedResult,
      database: dbResults,
      storage: storageResults,
      cleanup: {
        projectsCreated: projectsInsertedCount,
        mediaAssetsCreated: mediaAssetsInsertedCount,
        storageObjectsCreated,
        projectDeletionAttempted: cleanup.projectDeletionAttempted,
        mediaAssetDeletionAttempted: cleanup.mediaAssetDeletionAttempted,
        storageDeletionAttempted: cleanup.storageDeletionAttempted || inlineStorageObjectsRemoved > 0,
        projectsRemoved: cleanup.projectsRemoved,
        mediaAssetsRemoved: cleanup.mediaAssetsRemoved,
        storageObjectsRemoved: cleanup.storageObjectsRemoved + inlineStorageObjectsRemoved,
        residualVerifierProjects: cleanup.residualVerifierProjects,
        residualVerifierStorageObjects: cleanup.residualVerifierStorageObjects,
        errors: cleanup.errors,
        clean: cleanup.clean,
      },
    };

    return {
      report,
      success: errors.length === 0 && cleanup.clean,
      errors,
    };
  }
}
