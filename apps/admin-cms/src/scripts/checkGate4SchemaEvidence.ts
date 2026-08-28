import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareGate4Evidence,
  formatGate4Comparison,
  validateCurrentRepositoryGate4Contract,
  type Gate4ComparisonResult,
} from '../deployment/gate4SchemaEvidence';
import { configuredProjectId } from '../local-development/localStackState';

const MAX_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024;
const LOCAL_QUERY_TIMEOUT_MS = 120_000;

interface CliOptions {
  evidenceFile?: string;
  localSelfCheck: boolean;
  machineReadable: boolean;
  expectedGitSha?: string;
}

function parseArguments(args: readonly string[]): CliOptions {
  const options: CliOptions = { localSelfCheck: false, machineReadable: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--local-self-check') options.localSelfCheck = true;
    else if (argument === '--machine-readable') options.machineReadable = true;
    else if (argument.startsWith('--evidence-file=')) options.evidenceFile = argument.slice('--evidence-file='.length);
    else if (argument === '--evidence-file' && args[index + 1]) options.evidenceFile = args[++index];
    else if (argument.startsWith('--expected-git-sha=')) options.expectedGitSha = argument.slice('--expected-git-sha='.length);
    else if (argument === '--expected-git-sha' && args[index + 1]) options.expectedGitSha = args[++index];
    else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  if (options.localSelfCheck === Boolean(options.evidenceFile)) throw new Error('EXACTLY_ONE_EVIDENCE_MODE_REQUIRED');
  if (options.expectedGitSha !== undefined && !/^[0-9a-f]{40}$/.test(options.expectedGitSha)) throw new Error('EXPECTED_GIT_SHA_INVALID');
  return options;
}

function repositoryMigrationVersions(repoRoot: string): string[] {
  const migrationDirectory = path.join(repoRoot, 'infra', 'supabase', 'migrations');
  return fs.readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      const version = file.match(/^(\d{14})_/)?.[1];
      if (!version) throw new Error('REPOSITORY_MIGRATION_FILENAME_INVALID');
      return version;
    });
}

function localProjectId(repoRoot: string): string {
  const projectId = process.env.CAPSTONE_GATE4_LOCAL_PROJECT_ID ?? configuredProjectId(repoRoot);
  if (!projectId || !/^[a-z0-9-]+$/.test(projectId)) throw new Error('LOCAL_PROJECT_ID_INVALID');
  return projectId;
}

function exactDatabaseContainer(projectId: string): string {
  let output: string;
  try {
    output = execFileSync('docker', [
      'ps',
      '--filter', `label=com.supabase.cli.project=${projectId}`,
      '--filter', `name=^/supabase_db_${projectId}$`,
      '--format', '{{.Names}}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  } catch {
    throw new Error('LOCAL_DATABASE_INSPECTION_FAILED');
  }
  const names = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const expected = `supabase_db_${projectId}`;
  if (names.length !== 1 || names[0] !== expected) throw new Error('LOCAL_DATABASE_NOT_RUNNING');
  return expected;
}

/** Reads only the database container owned by the selected Local Supabase project. */
export function collectLocalGate4Evidence(repoRoot: string): unknown {
  const query = fs.readFileSync(path.join(repoRoot, 'infra', 'supabase', 'gate4-schema-evidence.sql'), 'utf8');
  const container = exactDatabaseContainer(localProjectId(repoRoot));
  let output: string;
  try {
    output = execFileSync('docker', [
      'exec', '-i',
      '-e', 'PGOPTIONS=-c statement_timeout=60000 -c lock_timeout=5000 -c default_transaction_read_only=on',
      container,
      'psql', '-U', 'postgres', '-d', 'postgres', '-qAtX', '-v', 'ON_ERROR_STOP=1',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: query,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: LOCAL_QUERY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error('LOCAL_GATE4_QUERY_FAILED');
  }
  try {
    return JSON.parse(output.trim()) as unknown;
  } catch {
    throw new Error('LOCAL_GATE4_QUERY_OUTPUT_INVALID');
  }
}

function unwrapEvidenceDocument(input: unknown): unknown {
  if (Array.isArray(input)) {
    if (input.length !== 1) return input;
    return unwrapEvidenceDocument(input[0]);
  }
  if (input !== null && typeof input === 'object') {
    const object = input as Record<string, unknown>;
    if ('gate4_evidence' in object) return object.gate4_evidence;
    if ('gate4Evidence' in object) return object.gate4Evidence;
    if (Array.isArray(object.rows)) return unwrapEvidenceDocument(object.rows);
  }
  return input;
}

function readHostedEvidence(file: string): unknown {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES) throw new Error('EVIDENCE_FILE_INVALID');
  try {
    return unwrapEvidenceDocument(JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown);
  } catch {
    throw new Error('EVIDENCE_FILE_INVALID');
  }
}

function currentGitSha(repoRoot: string): string {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('REPOSITORY_GIT_SHA_INVALID');
  return sha;
}

function invalidResult(errors: readonly string[]): Gate4ComparisonResult {
  return {
    classification: 'EVIDENCE_INVALID',
    validationErrors: [...errors],
    differences: [],
    totalDifferences: 0,
    categoryMatches: {},
  };
}

function machineResult(result: Gate4ComparisonResult, repositoryGitSha: string): Record<string, unknown> {
  return {
    classification: result.classification,
    repositoryGitSha,
    expected: result.expectedStats ?? null,
    actual: result.actualStats ?? null,
    categoryMatches: result.categoryMatches,
    totalDifferences: result.totalDifferences,
    differences: result.differences,
    validationErrors: result.validationErrors,
  };
}

function exitCode(classification: Gate4ComparisonResult['classification']): number {
  if (classification === 'GATE4_MATCH') return 0;
  return classification === 'GATE4_DRIFT' ? 2 : 3;
}

function main(): void {
  const repoRoot = path.resolve(__dirname, '../../../..');
  let options: CliOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'ARGUMENTS_INVALID';
    console.error(`GATE4_CLASSIFICATION=EVIDENCE_INVALID\nINVALID=${reason}`);
    process.exitCode = 3;
    return;
  }

  try {
    const repositoryGitSha = currentGitSha(repoRoot);
    if (options.expectedGitSha && options.expectedGitSha !== repositoryGitSha) throw new Error('REPOSITORY_GIT_SHA_MISMATCH');
    const expected = collectLocalGate4Evidence(repoRoot);
    const expectedErrors = validateCurrentRepositoryGate4Contract(expected, repositoryMigrationVersions(repoRoot));
    const result = expectedErrors.length > 0
      ? invalidResult(expectedErrors.map((error) => `expected: ${error}`))
      : compareGate4Evidence(expected, options.localSelfCheck ? expected : readHostedEvidence(options.evidenceFile!));
    console.log(options.machineReadable
      ? JSON.stringify(machineResult(result, repositoryGitSha))
      : formatGate4Comparison(result, repositoryGitSha));
    process.exitCode = exitCode(result.classification);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'GATE4_CHECK_FAILED';
    const result = invalidResult([reason]);
    console.log(options.machineReadable
      ? JSON.stringify(machineResult(result, 'UNKNOWN'))
      : formatGate4Comparison(result));
    process.exitCode = 3;
  }
}

if (require.main === module) main();
