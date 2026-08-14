import { describe, it, expect, vi } from 'vitest';
import {
  calculatePercentile,
  calculateTimingSummary,
  calculateThroughput,
  formatBytes,
  formatMs,
  formatThroughput,
  formatReportTable,
  LocalScalingReport,
  BENCHMARK_STORAGE_SIZES,
  BENCHMARK_STORAGE_EXTENSION,
  BENCHMARK_STORAGE_MIME_TYPE,
} from './scalingBenchmarkTypes';
import {
  adaptSyntheticProjectForDb,
  createDeterministicStoragePayload,
} from './localScalingFixtureAdapter';
import { parseCliArgs } from '../scripts/benchmarkLocalScaling';
import { generateSyntheticProjects } from '../fixtures/syntheticProjects';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import {
  CleanupDependencies,
  assertDashboardDelta,
  assertFilterOptions,
  assertSorted,
  cleanupVerifierArtifacts,
  countSearchMatches,
} from './localScalingRunner';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';

describe('Local Scaling Benchmark Statistics & Utilities', () => {
  it('calculates percentiles correctly using nearest-rank', () => {
    expect(calculatePercentile([], 0.5)).toBe(0);
    expect(calculatePercentile([42], 0.5)).toBe(42);
    expect(calculatePercentile([42], 0.95)).toBe(42);

    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(calculatePercentile(values, 0.5)).toBe(50);
    expect(calculatePercentile(values, 0.95)).toBe(100);
    expect(calculatePercentile(values, 0.1)).toBe(10);
    expect(calculatePercentile(values, 0)).toBe(10);
    expect(calculatePercentile(values, 1)).toBe(100);
  });

  it('computes statistical timing summary (min, median, mean, p95)', () => {
    expect(calculateTimingSummary([])).toEqual({ min: 0, median: 0, mean: 0, p95: 0 });

    const durations = [12.5, 10.0, 15.0, 20.0, 11.5];
    const summary = calculateTimingSummary(durations);

    expect(summary.min).toBe(10.0);
    expect(summary.mean).toBe(13.8);
    expect(summary.median).toBe(12.5);
    expect(summary.p95).toBe(20.0);
  });

  it('calculates accurate storage transfer throughput in MiB/s', () => {
    expect(calculateThroughput(0, 100)).toBe(0);
    expect(calculateThroughput(1024 * 1024, 0)).toBe(0);

    // 1 MiB transferred in 1000ms = 1.00 MiB/s
    expect(calculateThroughput(1024 * 1024, 1000)).toBe(1.0);

    // 5 MiB transferred in 500ms = 10.00 MiB/s
    expect(calculateThroughput(5 * 1024 * 1024, 500)).toBe(10.0);

    // 256 KiB transferred in 100ms = 2.50 MiB/s
    expect(calculateThroughput(256 * 1024, 100)).toBe(2.5);
  });

  it('formats byte sizes, durations, and throughput cleanly', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(256 * 1024)).toBe('256.0 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MiB');

    expect(formatMs(12.3456)).toBe('12.35 ms');
    expect(formatThroughput(45.678)).toBe('45.68 MiB/s');
  });

  it('formats a complete human-readable report table', () => {
    const mockReport: LocalScalingReport = {
      timestamp: '2026-08-14T12:00:00.000Z',
      datasetSize: 100,
      seed: 0xD4072026,
      environment: 'Local Supabase (loopback)',
      population: {
        baselineTotalProjects: 4,
        postSeedTotalProjects: 104,
        baselinePublishedProjects: 1,
        postSeedPublishedProjects: 13,
        syntheticPublishedProjects: 12,
        baselineVerifierProjects: 0,
        baselineStorageObjects: 0,
        baselineDashboard: { totalProjects: 4, publicEligible: 2, inReview: 1, archived: 0 },
        postSeedDashboard: { totalProjects: 104, publicEligible: 27, inReview: 14, archived: 12 },
        baselineFilterOptions: { years: ['2025'], programs: ['Baseline'], disciplines: ['Baseline'] },
      },
      seeding: {
        projectCount: 100,
        durationMs: 450.5,
        projectsPerSecond: 222.0,
      },
      database: [
        {
          operation: 'Pagination (Page 1, Size 10)',
          category: 'pagination',
          iterations: 5,
          resultCount: 10,
          timings: { min: 5.2, median: 6.1, mean: 6.4, p95: 8.0 },
        },
        {
          operation: 'Feed DB Retrieval (Total Local Projects)',
          category: 'feed-query',
          iterations: 5,
          resultCount: 104,
          timings: { min: 5.2, median: 6.1, mean: 6.4, p95: 8.0 },
        },
        {
          operation: 'Public Feed Compilation (Total Local Published)',
          category: 'feed-compile',
          iterations: 5,
          resultCount: 13,
          timings: { min: 0.2, median: 0.3, mean: 0.3, p95: 0.4 },
        },
        {
          operation: 'Public Feed Schema Validation',
          category: 'feed-validation',
          iterations: 5,
          resultCount: 13,
          timings: { min: 0.2, median: 0.3, mean: 0.3, p95: 0.4 },
        },
      ],
      storage: [
        {
          sizeLabel: '1 MiB',
          sizeBytes: 1024 * 1024,
          uploadDurationMs: 50.0,
          uploadThroughputMibPerSec: 20.0,
          downloadDurationMs: 40.0,
          downloadThroughputMibPerSec: 25.0,
          integrityVerified: true,
          sha256: 'mock-sha256',
        },
      ],
      cleanup: {
        projectsCreated: 100,
        mediaAssetsCreated: 300,
        storageObjectsCreated: 3,
        projectDeletionAttempted: true,
        mediaAssetDeletionAttempted: true,
        storageDeletionAttempted: true,
        projectsRemoved: 100,
        mediaAssetsRemoved: 300,
        storageObjectsRemoved: 3,
        residualVerifierProjects: 0,
        residualVerifierStorageObjects: 0,
        errors: [],
        clean: true,
      },
    };

    const table = formatReportTable(mockReport);
    expect(table).toContain('LOCAL SUPABASE SCALING & PERFORMANCE VERIFICATION REPORT');
    expect(table).toContain('Dataset Size:   100 projects');
    expect(table).toContain('Pagination (Page 1, Size 10)');
    expect(table).toContain('1 MiB');
    expect(table).toContain('VERIFIED MATCH');
    expect(table).toContain('4 baseline + 100 synthetic = 104 Local total');
    expect(table).toContain('Feed DB Retrieval');
    expect(table).toContain('Public Feed Compilation');
    expect(table).toContain('Public Feed Schema Validation');
    expect(table).toContain('Created:                 100 projects');
    expect(table).toContain('Confirmed Removed:       100 projects');
    expect(table).toContain('CLEAN (0 RESIDUE PROVEN)');
  });
});

describe('Local Scaling Fixture Adapter & Storage Payloads', () => {
  it('adapts synthetic projects with run prefix, production media, and valid contact emails', () => {
    const [project] = generateSyntheticProjects({ count: 100 });
    const runPrefix = 'scalebench-test1234';

    const adapted = adaptSyntheticProjectForDb(project, runPrefix);

    expect(adapted.projectRow.public_id).toBe(`${runPrefix}-${project.publicId}`);
    expect(adapted.projectRow.participant_contact_email).toBe(`${runPrefix}-${project.publicId}-contact@example.test`);
    expect(adapted.projectRow.title).toBe(project.title);

    // Media rows
    expect(adapted.mediaRows.length).toBeGreaterThanOrEqual(2);
    const posterImage = adapted.mediaRows.find((m) => m.asset_type === 'poster_image');
    expect(posterImage).toBeDefined();
    expect(posterImage?.mime_type).toBe('image/png');
    expect(posterImage?.file_size_bytes).toBe(1048576);

    const posterPdf = adapted.mediaRows.find((m) => m.asset_type === 'poster_pdf');
    expect(posterPdf).toBeDefined();
    expect(posterPdf?.mime_type).toBe('application/pdf');
    expect(posterPdf?.file_size_bytes).toBe(2097152);

    if (adapted.mediaRows.some((m) => m.asset_type === 'snapshot_image')) {
      const snapshot = adapted.mediaRows.find((m) => m.asset_type === 'snapshot_image');
      expect(snapshot?.mime_type).toBe('image/png');
      expect(snapshot?.file_size_bytes).toBe(524288);
      expect(typeof snapshot?.alt_text_public).toBe('string');
      expect((snapshot?.alt_text_public as string).length).toBeGreaterThan(0);
    }
  });

  it('generates deterministic storage payloads with consistent SHA-256 checksums', () => {
    expect(BENCHMARK_STORAGE_MIME_TYPE).toBe('image/png');
    expect(BENCHMARK_STORAGE_EXTENSION).toBe('png');
    for (const size of BENCHMARK_STORAGE_SIZES) {
      const payload1 = createDeterministicStoragePayload(size.bytes, 'run-1');
      const payload2 = createDeterministicStoragePayload(size.bytes, 'run-1');
      const payloadOther = createDeterministicStoragePayload(size.bytes, 'run-2');

      expect(payload1.buffer.length).toBe(size.bytes);
      expect(payload1.sha256).toBe(payload2.sha256);
      expect(payload1.buffer.equals(payload2.buffer)).toBe(true);
      expect([...payload1.buffer.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(payload1.buffer.subarray(-12, -8).readUInt32BE()).toBe(0);
      expect(payload1.buffer.subarray(-8, -4).toString('ascii')).toBe('IEND');

      // Different seed tag produces different hash
      expect(payload1.sha256).not.toBe(payloadOther.sha256);
    }
  });
});

describe('CLI Benchmark Argument Parsing & Environment Safety', () => {
  it('parses default benchmark options', () => {
    const opts = parseCliArgs([]);
    expect(opts.counts).toEqual([100]);
    expect(opts.seed).toBe(0xD4072026);
    expect(opts.warmupIterations).toBe(2);
    expect(opts.measuredIterations).toBe(5);
  });

  it('parses explicit counts and flags', () => {
    expect(parseCliArgs(['--count', '500']).counts).toEqual([500]);
    expect(parseCliArgs(['--count', '1000']).counts).toEqual([1000]);
    expect(parseCliArgs(['--all']).counts).toEqual([100, 500, 1000]);
    expect(parseCliArgs(['--warmup', '4', '--iterations', '10', '--seed', '12345'])).toMatchObject({
      warmupIterations: 4,
      measuredIterations: 10,
      seed: 12345,
    });
  });

  it('rejects unsupported dataset counts', () => {
    expect(() => parseCliArgs(['--count', '250'])).toThrow(/Invalid --count/);
    expect(() => parseCliArgs(['--count', '0'])).toThrow(/Invalid --count/);
  });

  it.each([
    ['--count'],
    ['--count', '100x'],
    ['--seed'],
    ['--seed', 'NaN'],
    ['--seed', '-1'],
    ['--seed', '4294967296'],
    ['--warmup'],
    ['--warmup', '-1'],
    ['--warmup', '1.5'],
    ['--iterations'],
    ['--iterations', '0'],
    ['--iterations', '-1'],
    ['--iterations', 'NaN'],
  ])('rejects malformed or out-of-range numeric arguments: %s', (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });

  it('rejects unknown, duplicate, and conflicting options', () => {
    expect(() => parseCliArgs(['--iteratons', '5'])).toThrow(/Unknown benchmark option/);
    expect(() => parseCliArgs(['--seed', '1', '--seed', '2'])).toThrow(/Duplicate option/);
    expect(() => parseCliArgs(['--all', '--count', '100'])).toThrow(/exactly one/);
  });

  it('validates loopback endpoints strictly', () => {
    expect(isLoopbackUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isLoopbackUrl('http://localhost:54321')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:54321')).toBe(true);

    expect(isLoopbackUrl('https://example.supabase.co')).toBe(false);
    expect(isLoopbackUrl('https://staging-project.supabase.co')).toBe(false);
    expect(isLoopbackUrl('https://duda.co')).toBe(false);
    expect(isLoopbackUrl('invalid-url')).toBe(false);
  });
});

function cleanupDependencies(overrides: Partial<CleanupDependencies> = {}): CleanupDependencies {
  return {
    findVerifierProjectIds: vi.fn().mockResolvedValue({ data: ['project-1'] }),
    deleteVerifierMedia: vi.fn().mockResolvedValue({ data: 3 }),
    deleteVerifierProjects: vi.fn().mockResolvedValue({ data: 1 }),
    countVerifierProjects: vi.fn().mockResolvedValue({ data: 0 }),
    listVerifierStorage: vi.fn()
      .mockResolvedValueOnce({ data: ['performance-verification/run/file.png'] })
      .mockResolvedValueOnce({ data: [] }),
    removeVerifierStorage: vi.fn().mockResolvedValue({ data: 1 }),
    ...overrides,
  };
}

describe('Local scaling cleanup evidence', () => {
  it('reports only confirmed deletion evidence and proves zero residue', async () => {
    const result = await cleanupVerifierArtifacts(cleanupDependencies());
    expect(result).toMatchObject({
      projectsRemoved: 1,
      mediaAssetsRemoved: 3,
      storageObjectsRemoved: 1,
      residualVerifierProjects: 0,
      residualVerifierStorageObjects: 0,
      clean: true,
    });
  });

  it('fails closed when finding verifier projects fails', async () => {
    const dependencies = cleanupDependencies({
      findVerifierProjectIds: vi.fn().mockResolvedValue({ data: [], error: new Error('find failed') }),
    });
    const result = await cleanupVerifierArtifacts(dependencies);
    expect(result.clean).toBe(false);
    expect(result.errors.join(' ')).toContain('find failed');
    expect(dependencies.deleteVerifierProjects).not.toHaveBeenCalled();
  });

  it.each([
    ['media deletion', { deleteVerifierMedia: vi.fn().mockResolvedValue({ data: 0, error: new Error('media delete failed') }) }],
    ['project deletion', { deleteVerifierProjects: vi.fn().mockResolvedValue({ data: 0, error: new Error('project delete failed') }) }],
  ])('fails closed on %s while continuing later cleanup', async (_label, overrides) => {
    const dependencies = cleanupDependencies(overrides);
    const result = await cleanupVerifierArtifacts(dependencies);
    expect(result.clean).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(dependencies.countVerifierProjects).toHaveBeenCalled();
    expect(dependencies.listVerifierStorage).toHaveBeenCalledTimes(2);
  });

  it('does not turn a residue-query error into zero', async () => {
    const result = await cleanupVerifierArtifacts(cleanupDependencies({
      countVerifierProjects: vi.fn().mockResolvedValue({ data: 0, error: new Error('count failed') }),
    }));
    expect(result.residualVerifierProjects).toBeNull();
    expect(result.clean).toBe(false);
  });

  it('fails closed when the initial Storage list fails', async () => {
    const listVerifierStorage = vi.fn()
      .mockResolvedValueOnce({ data: [], error: new Error('list failed') })
      .mockResolvedValueOnce({ data: [] });
    const result = await cleanupVerifierArtifacts(cleanupDependencies({ listVerifierStorage }));
    expect(result.clean).toBe(false);
    expect(result.errors.join(' ')).toContain('list failed');
  });

  it('fails closed when Storage removal fails and still performs the final list', async () => {
    const dependencies = cleanupDependencies({
      removeVerifierStorage: vi.fn().mockResolvedValue({ data: 0, error: new Error('remove failed') }),
    });
    const result = await cleanupVerifierArtifacts(dependencies);
    expect(result.clean).toBe(false);
    expect(result.errors.join(' ')).toContain('remove failed');
    expect(dependencies.listVerifierStorage).toHaveBeenCalledTimes(2);
  });

  it('marks final Storage residue unproven when the final list fails', async () => {
    const listVerifierStorage = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [], error: new Error('final list failed') });
    const result = await cleanupVerifierArtifacts(cleanupDependencies({ listVerifierStorage }));
    expect(result.residualVerifierStorageObjects).toBeNull();
    expect(result.clean).toBe(false);
  });
});

describe('Local scaling correctness gates', () => {
  const projects = generateSyntheticProjects({ count: 100 });

  it('calculates deterministic search contributions from production search fields', () => {
    expect(countSearchMatches(projects, 'Signal')).toBe(
      projects.filter((project) => project.title.includes('Signal')).length,
    );
    expect(countSearchMatches(projects, 'does-not-exist')).toBe(0);
  });

  it('checks filtering fields and deterministic sorting including public ID ties', () => {
    const filtered = projects.filter((project) => project.year === '2026' && project.status === 'published');
    expect(filtered.every((project) => project.year === '2026' && project.status === 'published')).toBe(true);
    const sorted = [...projects].sort((left, right) => right.year.localeCompare(left.year) || (left.publicId || '').localeCompare(right.publicId || ''));
    expect(() => assertSorted(sorted, (project) => Number(project.year), 'desc', 'year')).not.toThrow();
    expect(() => assertSorted([...sorted].reverse(), (project) => Number(project.year), 'desc', 'year')).toThrow();
  });

  it('validates dashboard baseline plus exact synthetic status deltas', () => {
    const baseline = { totalProjects: 4, publicEligible: 2, inReview: 1, archived: 1 };
    const postSeed = {
      totalProjects: baseline.totalProjects + projects.length,
      publicEligible: baseline.publicEligible + projects.filter((project) => ['approved', 'published'].includes(project.status)).length,
      inReview: baseline.inReview + projects.filter((project) => project.status === 'in_review').length,
      archived: baseline.archived + projects.filter((project) => project.status === 'archived').length,
    };
    expect(() => assertDashboardDelta(baseline, postSeed, projects)).not.toThrow();
    expect(() => assertDashboardDelta(baseline, { ...postSeed, totalProjects: postSeed.totalProjects - 1 }, projects)).toThrow();
  });

  it('requires every baseline and synthetic filter option after seeding', () => {
    const baseline = { years: ['2021'], programs: ['Baseline Program'], disciplines: ['Baseline Discipline'] };
    const postSeed = {
      years: [...baseline.years, ...new Set(projects.map((project) => project.year))],
      programs: [...baseline.programs, ...new Set(projects.map((project) => project.program))],
      disciplines: [...baseline.disciplines, ...new Set(projects.map((project) => project.discipline))],
    };
    expect(() => assertFilterOptions(baseline, postSeed, projects)).not.toThrow();
    expect(() => assertFilterOptions(baseline, { ...postSeed, years: postSeed.years.filter((year) => year !== '2026') }, projects)).toThrow();
  });

  it('keeps feed DB input, production compilation, and production schema validation distinct', () => {
    const databaseProjects = projects;
    const compiled = compilePublicFeed(databaseProjects);
    const validation = validatePublicFeed(compiled);
    expect(databaseProjects).toHaveLength(100);
    expect(compiled).toHaveLength(projects.filter((project) => project.status === 'published').length);
    expect(validation.valid).toBe(true);
  });
});
