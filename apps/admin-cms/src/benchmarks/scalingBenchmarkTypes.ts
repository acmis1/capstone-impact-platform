import { SYNTHETIC_PROJECT_COUNTS, SyntheticProjectCount } from '../fixtures/syntheticProjects';
import { ProjectDashboardMetrics, ProjectFilterOptions } from '../domain/projectQuery';

export { SYNTHETIC_PROJECT_COUNTS };
export type { SyntheticProjectCount };

export const BENCHMARK_STORAGE_SIZES = [
  { label: '256 KiB', bytes: 256 * 1024 },
  { label: '1 MiB', bytes: 1024 * 1024 },
  { label: '5 MiB', bytes: 5 * 1024 * 1024 },
] as const;

export const BENCHMARK_STORAGE_MIME_TYPE = 'image/png';
export const BENCHMARK_STORAGE_EXTENSION = 'png';

export type BenchmarkStorageSizeLabel = (typeof BENCHMARK_STORAGE_SIZES)[number]['label'];

export interface TimingDistribution {
  min: number;
  median: number;
  mean: number;
  p95: number;
}

export interface SeedBenchmarkResult {
  projectCount: number;
  durationMs: number;
  projectsPerSecond: number;
}

export interface DatabaseBenchmarkResult {
  operation: string;
  category:
    | 'pagination'
    | 'search'
    | 'filtering'
    | 'sorting'
    | 'metrics'
    | 'filter-options'
    | 'feed-query'
    | 'feed-compile'
    | 'feed-validation';
  iterations: number;
  resultCount: number;
  timings: TimingDistribution;
}

export interface StorageBenchmarkResult {
  sizeLabel: BenchmarkStorageSizeLabel;
  sizeBytes: number;
  uploadDurationMs: number;
  uploadThroughputMibPerSec: number;
  downloadDurationMs: number;
  downloadThroughputMibPerSec: number;
  integrityVerified: boolean;
  sha256: string;
}

export interface LocalScalingReport {
  timestamp: string;
  datasetSize: SyntheticProjectCount;
  seed: number;
  environment: 'Local Supabase (loopback)';
  population: {
    baselineTotalProjects: number;
    postSeedTotalProjects: number;
    baselinePublishedProjects: number;
    postSeedPublishedProjects: number;
    syntheticPublishedProjects: number;
    baselineVerifierProjects: number;
    baselineStorageObjects: number;
    baselineDashboard: ProjectDashboardMetrics;
    postSeedDashboard: ProjectDashboardMetrics;
    baselineFilterOptions: ProjectFilterOptions;
  };
  seeding: SeedBenchmarkResult;
  database: DatabaseBenchmarkResult[];
  storage: StorageBenchmarkResult[];
  cleanup: {
    projectsCreated: number;
    mediaAssetsCreated: number;
    storageObjectsCreated: number;
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
  };
}

/**
 * Calculates a percentile value from a pre-sorted array of numbers.
 * Uses nearest-rank method with 1-based index capping.
 */
export function calculatePercentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const clampedP = Math.max(0, Math.min(1, p));
  const rank = Math.ceil(clampedP * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index];
}

/**
 * Derives statistical timing distribution (min, median, mean, p95) from raw durations in milliseconds.
 */
export function calculateTimingSummary(durations: number[]): TimingDistribution {
  if (durations.length === 0) {
    return { min: 0, median: 0, mean: 0, p95: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const min = sorted[0];
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = Number((sum / sorted.length).toFixed(3));
  const median = calculatePercentile(sorted, 0.5);
  const p95 = calculatePercentile(sorted, 0.95);

  return {
    min: Number(min.toFixed(3)),
    median: Number(median.toFixed(3)),
    mean,
    p95: Number(p95.toFixed(3)),
  };
}

/**
 * Calculates throughput in MiB/s given transferred bytes and duration in milliseconds.
 */
export function calculateThroughput(bytes: number, durationMs: number): number {
  if (durationMs <= 0 || bytes <= 0) return 0;
  const mibTransferred = bytes / (1024 * 1024);
  const seconds = durationMs / 1000;
  return Number((mibTransferred / seconds).toFixed(2));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatMs(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

export function formatThroughput(mibPerSec: number): string {
  return `${mibPerSec.toFixed(2)} MiB/s`;
}

/**
 * Formats a clean, tabular human-readable ASCII report for terminal and logs.
 */
export function formatReportTable(report: LocalScalingReport): string {
  const lines: string[] = [];

  lines.push('================================================================================');
  lines.push(` LOCAL SUPABASE SCALING & PERFORMANCE VERIFICATION REPORT`);
  lines.push('================================================================================');
  lines.push(` Environment:    ${report.environment}`);
  lines.push(` Dataset Size:   ${report.datasetSize} projects (Deterministic seed: 0x${report.seed.toString(16).toUpperCase()})`);
  lines.push(` Timestamp:      ${report.timestamp}`);
  lines.push(` Bulk Seeding:   ${report.seeding.projectCount} projects in ${formatMs(report.seeding.durationMs)} (${report.seeding.projectsPerSecond.toFixed(1)} proj/sec)`);
  lines.push('--------------------------------------------------------------------------------');
  lines.push(' DATABASE & PUBLIC FEED OPERATIONS:');
  lines.push('--------------------------------------------------------------------------------');
  lines.push(
    ' Operation'.padEnd(36) +
    'Category'.padEnd(16) +
    'Count'.padEnd(8) +
    'Min'.padEnd(10) +
    'Median'.padEnd(10) +
    'Mean'.padEnd(10) +
    'p95'
  );
  lines.push('-'.repeat(96));

  for (const db of report.database) {
    lines.push(
      ` ${db.operation}`.padEnd(36) +
      db.category.padEnd(16) +
      String(db.resultCount).padEnd(8) +
      formatMs(db.timings.min).padEnd(10) +
      formatMs(db.timings.median).padEnd(10) +
      formatMs(db.timings.mean).padEnd(10) +
      formatMs(db.timings.p95)
    );
  }

  lines.push('--------------------------------------------------------------------------------');
  lines.push(' LOCAL POPULATION BASELINE & VERIFIED DELTA:');
  lines.push('--------------------------------------------------------------------------------');
  lines.push(` Total Projects:          ${report.population.baselineTotalProjects} baseline + ${report.datasetSize} synthetic = ${report.population.postSeedTotalProjects} Local total`);
  lines.push(` Published Projects:      ${report.population.baselinePublishedProjects} baseline + ${report.population.syntheticPublishedProjects} synthetic = ${report.population.postSeedPublishedProjects} Local total`);
  lines.push(` Fresh Namespace Check:   ${report.population.baselineVerifierProjects} projects, ${report.population.baselineStorageObjects} storage files`);

  lines.push('--------------------------------------------------------------------------------');
  lines.push(' LOCAL STORAGE BANDWIDTH (project-drafts-private):');
  lines.push(' One transfer per size keeps CI bounded; byte length, SHA-256, removal, and final residue are correctness gates.');
  lines.push('--------------------------------------------------------------------------------');
  lines.push(
    ' Payload Size'.padEnd(16) +
    'Upload Time'.padEnd(14) +
    'Upload Rate'.padEnd(16) +
    'Download Time'.padEnd(16) +
    'Download Rate'.padEnd(16) +
    'Integrity (SHA-256)'
  );
  lines.push('-'.repeat(96));

  for (const st of report.storage) {
    lines.push(
      ` ${st.sizeLabel}`.padEnd(16) +
      formatMs(st.uploadDurationMs).padEnd(14) +
      formatThroughput(st.uploadThroughputMibPerSec).padEnd(16) +
      formatMs(st.downloadDurationMs).padEnd(16) +
      formatThroughput(st.downloadThroughputMibPerSec).padEnd(16) +
      (st.integrityVerified ? 'VERIFIED MATCH' : 'MISMATCH / FAILED')
    );
  }

  lines.push('--------------------------------------------------------------------------------');
  lines.push(' VERIFIER CLEANUP & ISOLATION:');
  lines.push('--------------------------------------------------------------------------------');
  lines.push(` Created:                 ${report.cleanup.projectsCreated} projects, ${report.cleanup.mediaAssetsCreated} media assets, ${report.cleanup.storageObjectsCreated} storage objects`);
  lines.push(` Deletion Attempted:      projects=${report.cleanup.projectDeletionAttempted}, media=${report.cleanup.mediaAssetDeletionAttempted}, storage=${report.cleanup.storageDeletionAttempted}`);
  lines.push(` Confirmed Removed:       ${report.cleanup.projectsRemoved} projects, ${report.cleanup.mediaAssetsRemoved} media assets, ${report.cleanup.storageObjectsRemoved} storage objects`);
  const projectResidue = report.cleanup.residualVerifierProjects === null ? 'UNPROVEN' : String(report.cleanup.residualVerifierProjects);
  const storageResidue = report.cleanup.residualVerifierStorageObjects === null ? 'UNPROVEN' : String(report.cleanup.residualVerifierStorageObjects);
  lines.push(` Final Residue:           ${projectResidue} projects, ${storageResidue} storage files`);
  lines.push(` Cleanup Errors:          ${report.cleanup.errors.length}`);
  lines.push(` Isolation Status:        ${report.cleanup.clean ? 'CLEAN (0 RESIDUE PROVEN)' : 'FAILED (ZERO RESIDUE NOT PROVEN)'}`);
  lines.push('================================================================================');

  return lines.join('\n');
}
