import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import { generateSyntheticProjects } from '../fixtures/syntheticProjects';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import {
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

const STORAGE_BUCKET = 'project-drafts-private';

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

  // 1. Enforce local loopback safety
  if (!isLoopbackUrl(apiUrl)) {
    throw new Error(
      `Security violation: Benchmark target URL [${apiUrl}] is not a loopback address. Only local Disposable Supabase is permitted.`
    );
  }

  const supabase: SupabaseClient = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const runId = randomUUID().replaceAll('-', '').slice(0, 10);
  const runPrefix = `scalebench-${runId}`;
  const storagePrefix = `performance-verification/${runId}`;

  const repository = new SupabaseProjectRepositoryCore(supabase);

  let seedResult: SeedBenchmarkResult = {
    projectCount: 0,
    durationMs: 0,
    projectsPerSecond: 0,
  };

  const dbResults: DatabaseBenchmarkResult[] = [];
  const storageResults: StorageBenchmarkResult[] = [];

  let projectsInsertedCount = 0;
  let mediaAssetsInsertedCount = 0;
  let storageObjectsCreated = 0;

  try {
    // 2. Generate and adapt synthetic dataset
    const syntheticProjects = generateSyntheticProjects({ count: datasetSize, seed });
    const adapted = syntheticProjects.map((p) => adaptSyntheticProjectForDb(p, runPrefix));

    // 3. Bulk Seed Database & Measure Insertion Time
    const seedStart = performance.now();

    // Insert projects in bounded batches (25 per batch)
    const BATCH_SIZE = 25;
    for (let i = 0; i < adapted.length; i += BATCH_SIZE) {
      const batchProjects = adapted.slice(i, i + BATCH_SIZE).map((a) => a.projectRow);
      const { data: insertedProjects, error: pError } = await supabase
        .from('projects')
        .insert(batchProjects)
        .select('id, public_id');

      if (pError || !insertedProjects) {
        throw new Error(`Failed to seed batch of synthetic projects: ${pError?.message}`);
      }

      projectsInsertedCount += insertedProjects.length;

      // Build and insert media assets for this batch
      const idMap = new Map<string, string>();
      insertedProjects.forEach((row: { id: string; public_id: string }) => {
        idMap.set(row.public_id, row.id);
      });

      const batchMedia: Array<Record<string, unknown>> = [];
      adapted.slice(i, i + BATCH_SIZE).forEach((a) => {
        const publicId = a.projectRow.public_id as string;
        const projectDbId = idMap.get(publicId);
        if (projectDbId) {
          a.mediaRows.forEach((m) => {
            batchMedia.push({
              ...m,
              project_id: projectDbId,
            });
          });
        }
      });

      if (batchMedia.length > 0) {
        const { data: insertedMedia, error: mError } = await supabase
          .from('media_assets')
          .insert(batchMedia)
          .select('id');

        if (mError) {
          throw new Error(`Failed to seed media assets for synthetic batch: ${mError.message}`);
        }
        mediaAssetsInsertedCount += (insertedMedia || []).length;
      }
    }

    const seedEnd = performance.now();
    const seedDurationMs = Number((seedEnd - seedStart).toFixed(2));
    seedResult = {
      projectCount: projectsInsertedCount,
      durationMs: seedDurationMs,
      projectsPerSecond: Number(((projectsInsertedCount / (seedDurationMs / 1000)) || 0).toFixed(1)),
    };

    // 4. Measure Database Query Operations
    const extractResultCount = (res: unknown): number => {
      if (Array.isArray(res)) return res.length;
      if (res && typeof res === 'object') {
        const obj = res as Record<string, unknown>;
        if (Array.isArray(obj.projects)) return obj.projects.length;
        if (typeof obj.totalProjects === 'number') return obj.totalProjects;
        if (Array.isArray(obj.years) || Array.isArray(obj.programs) || Array.isArray(obj.disciplines)) {
          const years = Array.isArray(obj.years) ? obj.years.length : 0;
          const progs = Array.isArray(obj.programs) ? obj.programs.length : 0;
          const discs = Array.isArray(obj.disciplines) ? obj.disciplines.length : 0;
          return years + progs + discs;
        }
      }
      return 0;
    };

    interface QueryOpConfig {
      operation: string;
      category: DatabaseBenchmarkResult['category'];
      run: () => Promise<unknown>;
      extractCount: (result: unknown) => number;
    }

    const queryOperations: QueryOpConfig[] = [
      // A. Pagination
      {
        operation: 'Pagination (Page 1, Size 10)',
        category: 'pagination',
        run: async () => repository.listProjectsPage({ search: runPrefix, page: 1, pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Pagination (Page 1, Size 50)',
        category: 'pagination',
        run: async () => repository.listProjectsPage({ search: runPrefix, page: 1, pageSize: 50 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Pagination (Page 5, Size 10)',
        category: 'pagination',
        run: async () => repository.listProjectsPage({ search: runPrefix, page: 5, pageSize: 10 }),
        extractCount: extractResultCount,
      },

      // B. Keyword Search
      {
        operation: 'Search ("Signal")',
        category: 'search',
        run: async () => repository.listProjectsPage({ search: 'Signal', pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Search ("Mapping")',
        category: 'search',
        run: async () => repository.listProjectsPage({ search: 'Mapping', pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Search (Run Public ID Prefix)',
        category: 'search',
        run: async () => repository.listProjectsPage({ search: runPrefix, pageSize: 50 }),
        extractCount: extractResultCount,
      },

      // C. Combined Filtering
      {
        operation: 'Filter (Year 2026)',
        category: 'filtering',
        run: async () => repository.listProjectsPage({ year: '2026', search: runPrefix, pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Filter (Status Published)',
        category: 'filtering',
        run: async () => repository.listProjectsPage({ status: 'published', search: runPrefix, pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Filter (Year 2026 + Published)',
        category: 'filtering',
        run: async () => repository.listProjectsPage({ year: '2026', status: 'published', search: runPrefix, pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Filter (Program + Discipline)',
        category: 'filtering',
        run: async () => repository.listProjectsPage({
          program: 'Synthetic Software Systems',
          discipline: 'Synthetic Software Engineering',
          search: runPrefix,
          pageSize: 10,
        }),
        extractCount: extractResultCount,
      },

      // D. Sorting
      {
        operation: 'Sort (Created At Descending)',
        category: 'sorting',
        run: async () => repository.listProjectsPage({ search: runPrefix, sort: 'created_at', direction: 'desc', pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Sort (Title Ascending)',
        category: 'sorting',
        run: async () => repository.listProjectsPage({ search: runPrefix, sort: 'title', direction: 'asc', pageSize: 10 }),
        extractCount: extractResultCount,
      },
      {
        operation: 'Sort (Year Descending)',
        category: 'sorting',
        run: async () => repository.listProjectsPage({ search: runPrefix, sort: 'year', direction: 'desc', pageSize: 10 }),
        extractCount: extractResultCount,
      },

      // E. Dashboard Metrics
      {
        operation: 'Dashboard Metrics',
        category: 'metrics',
        run: async () => repository.getProjectDashboardMetrics(),
        extractCount: extractResultCount,
      },

      // F. Filter Options
      {
        operation: 'Filter Options Retrieval',
        category: 'filter-options',
        run: async () => repository.getProjectFilterOptions(),
        extractCount: extractResultCount,
      },

      // G. Feed Retrieval Query (DB query measured separately from compilation/validation)
      {
        operation: 'Feed Query (Published DB Select)',
        category: 'feed-query',
        run: async () => {
          const { data, error } = await supabase
            .from('projects')
            .select('*, project_disciplines(disciplines(name)), media_assets(asset_type,public_url,alt_text_public,is_public_approved)')
            .is('deleted_at', null)
            .eq('status', 'published');
          if (error) throw new Error(error.message);
          return data;
        },
        extractCount: extractResultCount,
      },
    ];

    for (const op of queryOperations) {
      // Warmup
      for (let w = 0; w < warmupIterations; w++) {
        await op.run();
      }

      // Measured iterations
      const durations: number[] = [];
      let finalCount = 0;

      for (let m = 0; m < measuredIterations; m++) {
        const start = performance.now();
        const res = await op.run();
        const end = performance.now();
        durations.push(end - start);
        finalCount = op.extractCount(res);
      }

      dbResults.push({
        operation: op.operation,
        category: op.category,
        iterations: measuredIterations,
        resultCount: finalCount,
        timings: calculateTimingSummary(durations),
      });
    }

    // 5. Measure Local Storage Bandwidth in 'project-drafts-private'
    for (const sizeSpec of BENCHMARK_STORAGE_SIZES) {
      const payload = createDeterministicStoragePayload(sizeSpec.bytes, `${runId}_${sizeSpec.label}`);
      const storagePath = `${storagePrefix}/payload-${sizeSpec.label.replace(/\s+/g, '')}.bin`;

      // Upload
      const uploadStart = performance.now();
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, payload.buffer, {
          contentType: 'application/octet-stream',
          upsert: true,
        });
      const uploadEnd = performance.now();

      if (uploadError) {
        throw new Error(`Storage upload failed for ${sizeSpec.label}: ${uploadError.message}`);
      }
      storageObjectsCreated++;

      const uploadDurationMs = Number((uploadEnd - uploadStart).toFixed(2));
      const uploadThroughput = calculateThroughput(sizeSpec.bytes, uploadDurationMs);

      // Download
      const downloadStart = performance.now();
      const { data: downloadedBlob, error: downloadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(storagePath);
      const downloadEnd = performance.now();

      if (downloadError || !downloadedBlob) {
        throw new Error(`Storage download failed for ${sizeSpec.label}: ${downloadError?.message || 'Empty response'}`);
      }

      const downloadDurationMs = Number((downloadEnd - downloadStart).toFixed(2));
      const downloadThroughput = calculateThroughput(sizeSpec.bytes, downloadDurationMs);

      // Verify SHA-256 byte-for-byte integrity
      const downloadedBuffer = Buffer.from(await downloadedBlob.arrayBuffer());
      const downloadedSha256 = createHash('sha256').update(downloadedBuffer).digest('hex');
      const integrityVerified = (downloadedSha256 === payload.sha256) && (downloadedBuffer.length === payload.sizeBytes);

      if (!integrityVerified) {
        errors.push(`Storage payload ${sizeSpec.label} corrupted: expected ${payload.sha256}, got ${downloadedSha256}`);
      }

      storageResults.push({
        sizeLabel: sizeSpec.label,
        sizeBytes: sizeSpec.bytes,
        uploadDurationMs,
        uploadThroughputMibPerSec: uploadThroughput,
        downloadDurationMs,
        downloadThroughputMibPerSec: downloadThroughput,
        integrityVerified,
        sha256: downloadedSha256,
      });

      // Cleanup this specific file
      await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    // 6. Strict Teardown & Baseline Restoration
    let residualVerifierProjects = 0;
    let residualVerifierStorageObjects = 0;

    try {
      // Find verifier-owned project DB IDs
      const { data: verifierProjects } = await supabase
        .from('projects')
        .select('id')
        .like('public_id', `${runPrefix}-%`);

      const verifierIds = (verifierProjects || []).map((p: { id: string }) => p.id);

      if (verifierIds.length > 0) {
        // Delete media assets
        await supabase
          .from('media_assets')
          .delete()
          .in('project_id', verifierIds);

        // Delete projects
        await supabase
          .from('projects')
          .delete()
          .in('id', verifierIds);
      }

      // Check residual projects
      const { count: remainingProjectsCount } = await supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .like('public_id', `${runPrefix}-%`);

      residualVerifierProjects = remainingProjectsCount ?? 0;

      // Clean storage prefix
      const { data: storageFiles } = await supabase.storage
        .from(STORAGE_BUCKET)
        .list(storagePrefix);

      if (storageFiles && storageFiles.length > 0) {
        const filePaths = storageFiles.map((f) => `${storagePrefix}/${f.name}`);
        await supabase.storage.from(STORAGE_BUCKET).remove(filePaths);
      }

      const { data: remainingStorageFiles } = await supabase.storage
        .from(STORAGE_BUCKET)
        .list(storagePrefix);

      residualVerifierStorageObjects = (remainingStorageFiles || []).length;
    } catch (cleanupErr) {
      errors.push(`Cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }

    const clean = residualVerifierProjects === 0 && residualVerifierStorageObjects === 0;

    const report: LocalScalingReport = {
      timestamp: new Date().toISOString(),
      datasetSize,
      seed,
      environment: 'Local Supabase (loopback)',
      seeding: seedResult,
      database: dbResults,
      storage: storageResults,
      cleanup: {
        projectsRemoved: projectsInsertedCount,
        mediaAssetsRemoved: mediaAssetsInsertedCount,
        storageObjectsRemoved: storageObjectsCreated,
        residualVerifierProjects,
        residualVerifierStorageObjects,
        clean,
      },
    };

    return {
      report,
      success: errors.length === 0 && clean,
      errors,
    };
  }
}
