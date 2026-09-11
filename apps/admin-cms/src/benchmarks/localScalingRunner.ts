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
  scopeSyntheticTaxonomyName,
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
  deleteVerifierTaxonomyMappings?(projectIds: string[]): Promise<CleanupOperationResult<number>>;
  deleteVerifierMedia(projectIds: string[]): Promise<CleanupOperationResult<number>>;
  deleteVerifierProjects(projectIds: string[]): Promise<CleanupOperationResult<number>>;
  countVerifierProjects(): Promise<CleanupOperationResult<number>>;
  countVerifierTaxonomyMappings?(projectIds: string[]): Promise<CleanupOperationResult<number>>;
  deleteVerifierTaxonomy?(): Promise<CleanupOperationResult<number>>;
  countVerifierTaxonomy?(): Promise<CleanupOperationResult<number>>;
  verifyCatalogueBaseline?(): Promise<CleanupOperationResult<boolean>>;
  listVerifierStorage(): Promise<CleanupOperationResult<string[]>>;
  removeVerifierStorage(paths: string[]): Promise<CleanupOperationResult<number>>;
}

export interface CleanupEvidence {
  projectDeletionAttempted: boolean;
  taxonomyMappingsDeletionAttempted: boolean;
  taxonomyDeletionAttempted: boolean;
  mediaAssetDeletionAttempted: boolean;
  storageDeletionAttempted: boolean;
  projectsRemoved: number;
  taxonomyMappingsRemoved: number;
  taxonomyRowsRemoved: number;
  mediaAssetsRemoved: number;
  storageObjectsRemoved: number;
  residualVerifierProjects: number | null;
  residualVerifierTaxonomyMappings: number | null;
  residualVerifierTaxonomyRows: number | null;
  residualVerifierStorageObjects: number | null;
  catalogueBaselineUnchanged: boolean | null;
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
  let taxonomyMappingsDeletionAttempted = false;
  let taxonomyDeletionAttempted = false;
  let mediaAssetDeletionAttempted = false;
  let storageDeletionAttempted = false;
  let projectsRemoved = 0;
  let taxonomyMappingsRemoved = 0;
  let taxonomyRowsRemoved = 0;
  let mediaAssetsRemoved = 0;
  let storageObjectsRemoved = 0;
  let residualVerifierProjects: number | null = null;
  let residualVerifierTaxonomyMappings: number | null = null;
  let residualVerifierTaxonomyRows: number | null = null;
  let residualVerifierStorageObjects: number | null = null;
  let catalogueBaselineUnchanged: boolean | null = dependencies.verifyCatalogueBaseline ? null : true;
  let projectDeletionSucceeded = false;

  try {
    verifierIds = requireSuccessful(
      await dependencies.findVerifierProjectIds(),
      'Finding verifier-owned projects failed',
    );
  } catch (error) {
    errors.push(errorMessage(error));
  }

  if (verifierIds && verifierIds.length === 0) projectDeletionSucceeded = true;

  if (verifierIds && verifierIds.length > 0) {
    if (dependencies.deleteVerifierTaxonomyMappings) {
      taxonomyMappingsDeletionAttempted = true;
      try {
        taxonomyMappingsRemoved = requireSuccessful(
          await dependencies.deleteVerifierTaxonomyMappings(verifierIds),
          'Deleting verifier-owned taxonomy mappings failed',
        );
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }

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
      projectDeletionSucceeded = projectsRemoved === verifierIds.length;
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

  if (dependencies.countVerifierTaxonomyMappings && verifierIds) {
    try {
      residualVerifierTaxonomyMappings = requireSuccessful(
        await dependencies.countVerifierTaxonomyMappings(verifierIds),
        'Post-delete verifier taxonomy mapping residue query failed',
      );
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (dependencies.deleteVerifierTaxonomy && projectDeletionSucceeded && residualVerifierProjects === 0 && residualVerifierTaxonomyMappings === 0) {
    taxonomyDeletionAttempted = true;
    try {
      taxonomyRowsRemoved = requireSuccessful(
        await dependencies.deleteVerifierTaxonomy(),
        'Deleting verifier-owned taxonomy rows failed',
      );
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (dependencies.countVerifierTaxonomy) {
    try {
      residualVerifierTaxonomyRows = requireSuccessful(
        await dependencies.countVerifierTaxonomy(),
        'Post-delete verifier taxonomy residue query failed',
      );
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (dependencies.verifyCatalogueBaseline) {
    try {
      catalogueBaselineUnchanged = requireSuccessful(
        await dependencies.verifyCatalogueBaseline(),
        'Catalogue baseline comparison failed',
      );
    } catch (error) {
      errors.push(errorMessage(error));
    }
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
    && (residualVerifierTaxonomyMappings === null || residualVerifierTaxonomyMappings === 0)
    && (residualVerifierTaxonomyRows === null || residualVerifierTaxonomyRows === 0)
    && catalogueBaselineUnchanged === true
    && residualVerifierStorageObjects === 0;

  return {
    projectDeletionAttempted,
    taxonomyMappingsDeletionAttempted,
    taxonomyDeletionAttempted,
    mediaAssetDeletionAttempted,
    storageDeletionAttempted,
    projectsRemoved,
    taxonomyMappingsRemoved,
    taxonomyRowsRemoved,
    mediaAssetsRemoved,
    storageObjectsRemoved,
    residualVerifierProjects,
    residualVerifierTaxonomyMappings,
    residualVerifierTaxonomyRows,
    residualVerifierStorageObjects,
    catalogueBaselineUnchanged,
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
  const projectIds = result.projects.map((project) => project.publicId).filter(Boolean);
  assertCondition(new Set(projectIds).size === projectIds.length, `${label} returned duplicate parent projects`);
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
    ['industries', syntheticProjects.map((project) => project.industry)],
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

interface TaxonomyCatalogueState {
  disciplines: Array<{ id: string; name: string }>;
  industryCategories: Array<{ id: string; name: string }>;
}

interface TaxonomyOwnership {
  disciplineIds: string[];
  industryCategoryIds: string[];
}

interface RunTaxonomyFixture {
  disciplineIdsByName: Map<string, string>;
  industryCategoryIdsByName: Map<string, string>;
  ownership: TaxonomyOwnership;
}

async function readTaxonomyCatalogueState(
  supabase: SupabaseClient,
): Promise<CleanupOperationResult<TaxonomyCatalogueState>> {
  const [disciplines, industryCategories] = await Promise.all([
    supabase.from('disciplines').select('id, name').order('id', { ascending: true }),
    supabase.from('industry_categories').select('id, name').order('id', { ascending: true }),
  ]);
  const error = disciplines.error || industryCategories.error;
  if (error || disciplines.data === null || industryCategories.data === null) {
    return {
      data: { disciplines: [], industryCategories: [] },
      error: error || new Error('Taxonomy catalogue state was unavailable.'),
    };
  }
  return {
    data: {
      disciplines: disciplines.data as Array<{ id: string; name: string }>,
      industryCategories: industryCategories.data as Array<{ id: string; name: string }>,
    },
  };
}

async function insertRunTaxonomyRows(
  supabase: SupabaseClient,
  table: 'disciplines' | 'industry_categories',
  names: string[],
  destination: Map<string, string>,
  ownedIds: string[],
): Promise<void> {
  if (names.length === 0) return;
  const result = await supabase
    .from(table)
    .insert(names.map((name) => ({ name })))
    .select('id, name');
  if (result.error || result.data === null) {
    throw new Error(`Failed to seed synthetic ${table} catalogue: ${result.error?.message || 'missing inserted rows'}`);
  }
  const rows = result.data as Array<{ id: string; name: string }>;
  if (rows.length !== names.length) {
    throw new Error(`Synthetic ${table} catalogue returned ${rows.length} of ${names.length} inserted rows.`);
  }
  for (const row of rows) {
    destination.set(row.name, row.id);
    ownedIds.push(row.id);
  }
}

async function createRunTaxonomyFixture(
  supabase: SupabaseClient,
  adapted: Array<ReturnType<typeof adaptSyntheticProjectForDb>>,
  ownership: TaxonomyOwnership,
): Promise<RunTaxonomyFixture> {
  const disciplineNames = [...new Set(adapted.flatMap((item) => item.taxonomyMappingIntents.disciplineNames))].sort();
  const industryCategoryNames = [...new Set(adapted.flatMap((item) => item.taxonomyMappingIntents.industryCategoryNames))].sort();
  const disciplineIdsByName = new Map<string, string>();
  const industryCategoryIdsByName = new Map<string, string>();

  await insertRunTaxonomyRows(
    supabase,
    'disciplines',
    disciplineNames,
    disciplineIdsByName,
    ownership.disciplineIds,
  );
  await insertRunTaxonomyRows(
    supabase,
    'industry_categories',
    industryCategoryNames,
    industryCategoryIdsByName,
    ownership.industryCategoryIds,
  );

  assertCondition(disciplineNames.every((name) => disciplineIdsByName.has(name)), 'synthetic discipline catalogue rows were incomplete');
  assertCondition(industryCategoryNames.every((name) => industryCategoryIdsByName.has(name)), 'synthetic industry catalogue rows were incomplete');
  return { disciplineIdsByName, industryCategoryIdsByName, ownership };
}

function createCleanupDependencies(
  supabase: SupabaseClient,
  runPrefix: string,
  storagePrefix: string,
  taxonomyOwnership: TaxonomyOwnership,
  baselineTaxonomyState: TaxonomyCatalogueState | null,
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
    async deleteVerifierTaxonomyMappings(projectIds) {
      const [disciplines, industries] = await Promise.all([
        supabase.from('project_disciplines').delete().in('project_id', projectIds).select('project_id'),
        supabase.from('project_industry_categories').delete().in('project_id', projectIds).select('project_id'),
      ]);
      const errors = [disciplines.error, industries.error].filter(Boolean);
      return {
        data: (disciplines.data || []).length + (industries.data || []).length,
        error: errors[0] || (disciplines.data === null || industries.data === null
          ? new Error('Taxonomy mapping deletion returned no confirmation data.')
          : undefined),
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
    async countVerifierTaxonomyMappings(projectIds) {
      if (projectIds.length === 0) return { data: 0 };
      const [disciplines, industries] = await Promise.all([
        supabase.from('project_disciplines').select('project_id', { count: 'exact', head: true }).in('project_id', projectIds),
        supabase.from('project_industry_categories').select('project_id', { count: 'exact', head: true }).in('project_id', projectIds),
      ]);
      const errors = [disciplines.error, industries.error].filter(Boolean);
      return {
        data: (disciplines.count || 0) + (industries.count || 0),
        error: errors[0] || (disciplines.count === null || industries.count === null
          ? new Error('Taxonomy mapping residue count was unavailable.')
          : undefined),
      };
    },
    async deleteVerifierTaxonomy() {
      const [disciplines, industries] = await Promise.all([
        taxonomyOwnership.disciplineIds.length === 0
          ? Promise.resolve({ data: [] as Array<{ id: string }>, error: null })
          : supabase.from('disciplines').delete().in('id', taxonomyOwnership.disciplineIds).select('id'),
        taxonomyOwnership.industryCategoryIds.length === 0
          ? Promise.resolve({ data: [] as Array<{ id: string }>, error: null })
          : supabase.from('industry_categories').delete().in('id', taxonomyOwnership.industryCategoryIds).select('id'),
      ]);
      const errors = [disciplines.error, industries.error].filter(Boolean);
      return {
        data: (disciplines.data || []).length + (industries.data || []).length,
        error: errors[0] || (disciplines.data === null || industries.data === null
          ? new Error('Taxonomy catalogue deletion returned no confirmation data.')
          : undefined),
      };
    },
    async countVerifierTaxonomy() {
      const [disciplines, industries] = await Promise.all([
        taxonomyOwnership.disciplineIds.length === 0
          ? Promise.resolve({ count: 0, error: null })
          : supabase.from('disciplines').select('id', { count: 'exact', head: true }).in('id', taxonomyOwnership.disciplineIds),
        taxonomyOwnership.industryCategoryIds.length === 0
          ? Promise.resolve({ count: 0, error: null })
          : supabase.from('industry_categories').select('id', { count: 'exact', head: true }).in('id', taxonomyOwnership.industryCategoryIds),
      ]);
      const errors = [disciplines.error, industries.error].filter(Boolean);
      return {
        data: (disciplines.count || 0) + (industries.count || 0),
        error: errors[0] || (disciplines.count === null || industries.count === null
          ? new Error('Taxonomy catalogue residue count was unavailable.')
          : undefined),
      };
    },
    ...(baselineTaxonomyState ? {
      async verifyCatalogueBaseline() {
        const result = await readTaxonomyCatalogueState(supabase);
        if (result.error) return { data: false, error: result.error };
        return {
          data: JSON.stringify(result.data) === JSON.stringify(baselineTaxonomyState),
          error: undefined,
        };
      },
    } : {}),
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
  const emptyOptions: ProjectFilterOptions = { years: [], programs: [], disciplines: [], industries: [] };
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
  let taxonomyMappingsInsertedCount = 0;
  let mediaAssetsInsertedCount = 0;
  let storageObjectsCreated = 0;
  let inlineStorageObjectsRemoved = 0;
  const taxonomyOwnership: TaxonomyOwnership = { disciplineIds: [], industryCategoryIds: [] };
  let baselineTaxonomyState: TaxonomyCatalogueState | null = null;

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
    baselineTaxonomyState = requireSuccessful(
      await readTaxonomyCatalogueState(supabase),
      'Baseline taxonomy catalogue query failed',
    );

    const baselineSearchTotals = new Map<string, number>();
    for (const search of ['Signal', 'Mapping']) {
      baselineSearchTotals.set(search, (await repository.listProjectsPage({ search, pageSize: 10 })).total);
    }

    const syntheticProjects = generateSyntheticProjects({ count: datasetSize, seed });
    const adapted = syntheticProjects.map((project) => adaptSyntheticProjectForDb(project, runPrefix));
    const taxonomyFixture = await createRunTaxonomyFixture(supabase, adapted, taxonomyOwnership);
    const scopedSyntheticProjects = syntheticProjects.map((project, index) => ({
      ...project,
      publicId: `${runPrefix}-${project.publicId}`,
      discipline: String(adapted[index].projectRow.discipline || ''),
      disciplines: adapted[index].taxonomyMappingIntents.disciplineNames,
      industry: String(adapted[index].projectRow.industry || ''),
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
      const disciplineRows = batch.flatMap((item) => item.taxonomyMappingIntents.disciplineNames.map((name) => ({
        project_id: idByPublicId.get(String(item.projectRow.public_id)),
        discipline_id: taxonomyFixture.disciplineIdsByName.get(name),
      })));
      const industryRows = batch.flatMap((item) => item.taxonomyMappingIntents.industryCategoryNames.map((name) => ({
        project_id: idByPublicId.get(String(item.projectRow.public_id)),
        industry_category_id: taxonomyFixture.industryCategoryIdsByName.get(name),
      })));
      assertCondition(
        [...disciplineRows, ...industryRows].every((row) => row.project_id && ('discipline_id' in row ? row.discipline_id : row.industry_category_id)),
        'synthetic taxonomy mapping intents could not be resolved to inserted IDs',
      );
      const [disciplineInsert, industryInsert] = await Promise.all([
        supabase.from('project_disciplines').insert(disciplineRows).select('project_id, discipline_id'),
        supabase.from('project_industry_categories').insert(industryRows).select('project_id, industry_category_id'),
      ]);
      if (disciplineInsert.error || !disciplineInsert.data) {
        throw new Error(`Failed to seed synthetic discipline mappings: ${disciplineInsert.error?.message || 'missing inserted rows'}`);
      }
      if (industryInsert.error || !industryInsert.data) {
        throw new Error(`Failed to seed synthetic industry mappings: ${industryInsert.error?.message || 'missing inserted rows'}`);
      }
      taxonomyMappingsInsertedCount += disciplineInsert.data.length + industryInsert.data.length;
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
    const primaryDiscipline = scopeSyntheticTaxonomyName(runPrefix, 'discipline', 'Synthetic Software Engineering');
    const secondaryDiscipline = scopeSyntheticTaxonomyName(runPrefix, 'discipline', 'Synthetic Cross-Discipline');
    const technologyIndustry = scopeSyntheticTaxonomyName(runPrefix, 'industry', 'Synthetic Technology');
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
        discipline: primaryDiscipline,
        search: runPrefix,
        pageSize: 10,
      }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.program === 'Synthetic Software Systems' && project.disciplines.includes(primaryDiscipline));
        assertCondition(result.total === expected.length && result.projects.every((project) => project.program === 'Synthetic Software Systems' && project.disciplines.includes(primaryDiscipline)), 'program/discipline filtering was incorrect');
        assertScopedProjects(result, expectedIds, 'program/discipline filter');
      }),
      pageOperation('Filter (Secondary Discipline; Page 2, Size 25)', 'filtering', {
        discipline: secondaryDiscipline,
        search: runPrefix,
        page: 2,
        pageSize: 25,
      }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.disciplines.includes(secondaryDiscipline));
        assertCondition(
          result.total === expected.length
            && result.pageCount === Math.ceil(expected.length / 25)
            && result.projects.length === Math.min(25, Math.max(0, expected.length - 25)),
          'secondary discipline filtering or pagination was incorrect',
        );
        assertCondition(result.projects.every((project) => project.disciplines.includes(secondaryDiscipline)), 'secondary discipline relation was not retained');
        assertScopedProjects(result, expectedIds, 'secondary discipline filter');
      }),
      pageOperation('Filter (Industry)', 'filtering', {
        industry: technologyIndustry,
        search: runPrefix,
        pageSize: 10,
      }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.industry === technologyIndustry);
        assertCondition(result.total === expected.length && result.projects.every((project) => project.industry === technologyIndustry), 'industry filtering was incorrect');
        assertScopedProjects(result, expectedIds, 'industry filter');
      }),
      pageOperation('Filter (Discipline + Industry Intersection)', 'filtering', {
        discipline: primaryDiscipline,
        industry: technologyIndustry,
        search: runPrefix,
        pageSize: 10,
      }, (result) => {
        const expected = scopedSyntheticProjects.filter((project) => project.disciplines.includes(primaryDiscipline) && project.industry === technologyIndustry);
        assertCondition(
          expected.length > 0
            && result.total === expected.length
            && result.projects.every((project) => project.disciplines.includes(primaryDiscipline) && project.industry === technologyIndustry),
          'discipline/industry intersection filtering was incorrect',
        );
        assertScopedProjects(result, expectedIds, 'discipline/industry intersection filter');
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
          return optionsResult.years.length + optionsResult.programs.length + optionsResult.disciplines.length + optionsResult.industries.length;
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
      createCleanupDependencies(supabase, runPrefix, storagePrefix, taxonomyOwnership, baselineTaxonomyState),
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
        taxonomyMappingsCreated: taxonomyMappingsInsertedCount,
        taxonomyRowsCreated: taxonomyOwnership.disciplineIds.length + taxonomyOwnership.industryCategoryIds.length,
        mediaAssetsCreated: mediaAssetsInsertedCount,
        storageObjectsCreated,
        projectDeletionAttempted: cleanup.projectDeletionAttempted,
        taxonomyMappingsDeletionAttempted: cleanup.taxonomyMappingsDeletionAttempted,
        taxonomyDeletionAttempted: cleanup.taxonomyDeletionAttempted,
        mediaAssetDeletionAttempted: cleanup.mediaAssetDeletionAttempted,
        storageDeletionAttempted: cleanup.storageDeletionAttempted || inlineStorageObjectsRemoved > 0,
        projectsRemoved: cleanup.projectsRemoved,
        taxonomyMappingsRemoved: cleanup.taxonomyMappingsRemoved,
        taxonomyRowsRemoved: cleanup.taxonomyRowsRemoved,
        mediaAssetsRemoved: cleanup.mediaAssetsRemoved,
        storageObjectsRemoved: cleanup.storageObjectsRemoved + inlineStorageObjectsRemoved,
        residualVerifierProjects: cleanup.residualVerifierProjects,
        residualVerifierTaxonomyMappings: cleanup.residualVerifierTaxonomyMappings,
        residualVerifierTaxonomyRows: cleanup.residualVerifierTaxonomyRows,
        residualVerifierStorageObjects: cleanup.residualVerifierStorageObjects,
        catalogueBaselineUnchanged: cleanup.catalogueBaselineUnchanged,
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
