import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SYNTHETIC_SEED } from '../fixtures/syntheticProjects';
import {
  cleanupInterruptedReleaseEvaluationRun,
  runReleaseEvaluation,
  assertReleaseLocalTarget,
} from '../evaluation/releaseEvaluationHarness';
import {
  compareNormalizedReleaseReports,
  renderReleaseEvaluationJson,
  renderReleaseEvaluationMarkdown,
  summarizeReleaseTimings,
} from '../evaluation/releaseEvaluationReport';
import { parseSupabaseCliEnv, validateAllowedOutputPath } from '../local-development/localEnvironmentFile';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

interface CliOptions {
  runs: number;
  seed: number;
  outputDir?: string;
  evidence: boolean;
  cleanupRunNamespace?: string;
}

interface GracefulSignalController {
  setEvidenceResumer(resumer: () => void): void;
  resumeEvidence(): void;
  dispose(): void;
}

function installGracefulSignalHandlers(): GracefulSignalController {
  let resumeEvidence: (() => void) | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  (['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
    const handler = () => {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      resumeEvidence?.();
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  });
  return {
    setEvidenceResumer: (resumer) => { resumeEvidence = resumer; },
    resumeEvidence: () => resumeEvidence?.(),
    dispose: () => handlers.forEach((handler, signal) => process.removeListener(signal, handler)),
  };
}

function parseIntegerFlag(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${name}; expected a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}; value is out of range.`);
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { runs: 2, seed: DEFAULT_SYNTHETIC_SEED, evidence: false };
  for (const argument of argv) {
    if (argument === '--evidence') {
      options.evidence = true;
      continue;
    }
    const match = /^(--runs|--seed|--output-dir|--cleanup-run)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    if (match[1] === '--runs') options.runs = parseIntegerFlag(match[2], '--runs');
    else if (match[1] === '--seed') options.seed = parseIntegerFlag(match[2], '--seed');
    else if (match[1] === '--output-dir') options.outputDir = match[2];
    else options.cleanupRunNamespace = match[2];
  }
  if (options.runs < 1 || options.runs > 2) throw new Error('--runs must be 1 or 2.');
  if (options.evidence && options.runs !== 1) throw new Error('--evidence requires --runs=1.');
  if (options.cleanupRunNamespace && (options.evidence || options.outputDir)) {
    throw new Error('--cleanup-run cannot be combined with --evidence or --output-dir.');
  }
  return options;
}

function localSupabaseEnvironment(): { apiUrl: string; serviceRoleKey: string; cliVersion?: string } {
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const configuredKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (configuredUrl) assertReleaseLocalTarget(configuredUrl);
  if (configuredUrl && configuredKey) {
    process.env.SUPABASE_SECRET_KEY = configuredKey;
    return { apiUrl: configuredUrl, serviceRoleKey: configuredKey };
  }
  const cli = path.resolve(REPO_ROOT, 'node_modules/supabase/dist/supabase.js');
  const raw = execFileSync(process.execPath, [cli, 'status', '--workdir', path.resolve(REPO_ROOT, 'infra'), '-o', 'env'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  const parsed = parseSupabaseCliEnv(raw);
  if (!parsed.API_URL || !parsed.SERVICE_ROLE_KEY) {
    throw new Error('A running loopback Local Supabase stack is required for release evaluation.');
  }
  assertReleaseLocalTarget(parsed.API_URL);
  process.env.NEXT_PUBLIC_SUPABASE_URL = parsed.API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = parsed.ANON_KEY || '';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = parsed.ANON_KEY || '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = parsed.SERVICE_ROLE_KEY;
  process.env.SUPABASE_SECRET_KEY = parsed.SERVICE_ROLE_KEY;
  return { apiUrl: parsed.API_URL, serviceRoleKey: parsed.SERVICE_ROLE_KEY, cliVersion: parsed.VERSION };
}

function prepareOutputDirectory(customPath: string | undefined): string {
  const defaultPath = path.join(os.tmpdir(), 'capstone-release-evaluation-output');
  const outputDir = customPath ? path.resolve(customPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-release-evaluation-'));
  validateAllowedOutputPath(outputDir, defaultPath, REPO_ROOT);
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function localMigrationCount(): number {
  const migrationsDir = path.resolve(REPO_ROOT, 'infra', 'supabase', 'migrations');
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .length;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const signals = installGracefulSignalHandlers();
  try {
    const environment = localSupabaseEnvironment();
    if (options.cleanupRunNamespace) {
      const supabase = createClient(environment.apiUrl, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const cleanup = await cleanupInterruptedReleaseEvaluationRun({
        supabase,
        apiUrl: environment.apiUrl,
        runNamespace: options.cleanupRunNamespace,
      });
      process.stdout.write(`Interrupted release evaluation cleanup for ${cleanup.runNamespace}: ${cleanup.completed ? 'complete' : 'incomplete'}\n`);
      process.stdout.write(`Residue: ${JSON.stringify(cleanup.residue)}\n`);
      if (!cleanup.completed) process.exitCode = 1;
      return;
    }
    const outputDir = prepareOutputDirectory(options.outputDir);
    const reports = [];
    for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
      const supabase = createClient(environment.apiUrl, environment.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const report = await runReleaseEvaluation({
        supabase,
        apiUrl: environment.apiUrl,
        seed: options.seed,
        runNumber,
        npmVersion: process.env.npm_config_user_agent,
        osRelease: os.release(),
        supabaseVersion: environment.cliVersion,
        migrationCount: localMigrationCount(),
        evidenceMode: options.evidence,
        onRunNamespace: (runNamespace) => process.stdout.write(`Release evaluation run namespace: ${runNamespace}\n`),
        pauseForEvidence: options.evidence
          ? async () => {
              process.stdout.write('\nEvidence mode is active. Inspect the Local 120-project fixture, then press Enter to clean it up.\n');
              await new Promise<void>((resolve) => {
                let settled = false;
                const finish = () => {
                  if (settled) return;
                  settled = true;
                  process.stdin.removeListener('data', onData);
                  process.stdin.removeListener('end', finish);
                  process.stdin.pause();
                  process.stdin.unref?.();
                  resolve();
                };
                const onData = () => finish();
                signals.setEvidenceResumer(finish);
                process.stdin.once('data', onData);
                process.stdin.once('end', finish);
              });
            }
          : undefined,
      });
      reports.push(report);
    }
    if (reports.length > 1) {
      const comparison = compareNormalizedReleaseReports(reports[0], reports[1]);
      reports[reports.length - 1].repeatability = comparison;
      if (!comparison.comparable) {
        reports[reports.length - 1].gate.failureReasons.push('normalized repeatability comparison failed');
        reports[reports.length - 1].gate.passed = false;
      }
    }
    const finalReport = reports[reports.length - 1];
    if (reports.some((report) => !report.gate.passed)) {
      finalReport.gate.failureReasons.push('one or more complete runs failed; inspect the per-run reports');
      finalReport.gate.passed = false;
    }
    reports.forEach((report, index) => {
      fs.writeFileSync(path.join(outputDir, `release-evaluation-run-${index + 1}.json`), renderReleaseEvaluationJson(report), 'utf8');
    });
    finalReport.timingRuns = reports.map((report) => ({ runNumber: report.runtime.runNumber, timings: report.timings }));
    finalReport.timingSummary = summarizeReleaseTimings(reports.map((report) => report.timings));
    fs.writeFileSync(path.join(outputDir, 'release-evaluation-report.json'), renderReleaseEvaluationJson(finalReport), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'release-evaluation-report.md'), renderReleaseEvaluationMarkdown(finalReport), 'utf8');
    process.stdout.write(renderReleaseEvaluationMarkdown(finalReport));
    process.stdout.write(`\nReports written outside the repository: ${outputDir}\n`);
    if (!finalReport.gate.passed) process.exitCode = 1;
  } finally {
    signals.dispose();
    signals.resumeEvidence();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Release evaluation failed.'}\n`);
  process.exitCode = 1;
});
