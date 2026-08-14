import { describe, it, expect } from 'vitest';
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
} from './scalingBenchmarkTypes';
import {
  adaptSyntheticProjectForDb,
  createDeterministicStoragePayload,
} from './localScalingFixtureAdapter';
import { parseCliArgs } from '../scripts/benchmarkLocalScaling';
import { generateSyntheticProjects } from '../fixtures/syntheticProjects';
import { isLoopbackUrl } from '../local-development/localEnvironmentFile';

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
        projectsRemoved: 100,
        mediaAssetsRemoved: 300,
        storageObjectsRemoved: 3,
        residualVerifierProjects: 0,
        residualVerifierStorageObjects: 0,
        clean: true,
      },
    };

    const table = formatReportTable(mockReport);
    expect(table).toContain('LOCAL SUPABASE SCALING & PERFORMANCE VERIFICATION REPORT');
    expect(table).toContain('Dataset Size:   100 projects');
    expect(table).toContain('Pagination (Page 1, Size 10)');
    expect(table).toContain('1 MiB');
    expect(table).toContain('VERIFIED MATCH');
    expect(table).toContain('CLEAN (0 RESIDUE)');
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
    for (const size of BENCHMARK_STORAGE_SIZES) {
      const payload1 = createDeterministicStoragePayload(size.bytes, 'run-1');
      const payload2 = createDeterministicStoragePayload(size.bytes, 'run-1');
      const payloadOther = createDeterministicStoragePayload(size.bytes, 'run-2');

      expect(payload1.buffer.length).toBe(size.bytes);
      expect(payload1.sha256).toBe(payload2.sha256);
      expect(payload1.buffer.equals(payload2.buffer)).toBe(true);

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
