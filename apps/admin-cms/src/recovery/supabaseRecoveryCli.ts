import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildRecoveryEvidenceSql,
  parseRecoveryEvidence,
  type RecoveryEvidenceSnapshot,
} from './recoveryEvidenceSql';
import { DATABASE_BACKUP_ARTIFACTS, RecoveryGuardError } from './zeroCostRecoveryContract';

/**
 * Thin adapter over the repository-pinned Supabase CLI.
 *
 * Only read operations are exposed for a hosted source: logical dumps and a single read-only
 * evidence query. There is deliberately no push, reset, repair, or write path here, so no caller
 * can reach one by accident.
 */

export type RecoverySourceTarget =
  | { kind: 'hosted-linked'; workdir: string }
  | { kind: 'local'; workdir: string };

const EVIDENCE_QUERY_TIMEOUT_MS = 300_000;
const DUMP_TIMEOUT_MS = 900_000;

const CLI_ENVIRONMENT_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'DOCKER_HOST', 'DOCKER_CUSTOM_HEADERS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
] as const;

function restrictedCliEnvironment(target: RecoverySourceTarget): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    SUPABASE_TELEMETRY_DISABLED: '1',
  };
  for (const key of CLI_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (target.kind === 'hosted-linked') {
    for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD'] as const) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    environment.PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=120000';
  }
  return environment;
}

function cliShim(repositoryRoot: string): string {
  return path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js');
}

function targetFlags(target: RecoverySourceTarget): string[] {
  return [target.kind === 'hosted-linked' ? '--linked' : '--local', '--workdir', target.workdir];
}

export function supabaseCliVersion(repositoryRoot: string): string {
  try {
    const raw = fs.readFileSync(
      path.join(repositoryRoot, 'node_modules', 'supabase', 'package.json'),
      'utf8',
    );
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Reads the project ref the CLI itself recorded when the workspace was linked. This is the stable
 * metadata the target guard checks; a project name is never accepted as authority.
 */
export function readLinkedProjectRef(workdir: string): string | null {
  const file = path.join(workdir, 'supabase', '.temp', 'project-ref');
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function parseCliJson(output: string): unknown {
  const objectStart = output.indexOf('{');
  const arrayStart = output.indexOf('[');
  const start = objectStart < 0
    ? arrayStart
    : arrayStart < 0
      ? objectStart
      : Math.min(objectStart, arrayStart);
  if (start < 0) throw new RecoveryGuardError('SUPABASE_CLI_OUTPUT_UNPARSEABLE');
  const opener = output[start];
  const end = output.lastIndexOf(opener === '[' ? ']' : '}');
  if (end < start) throw new RecoveryGuardError('SUPABASE_CLI_OUTPUT_UNPARSEABLE');
  try {
    return JSON.parse(output.slice(start, end + 1)) as unknown;
  } catch {
    throw new RecoveryGuardError('SUPABASE_CLI_OUTPUT_UNPARSEABLE');
  }
}

/** Runs the single read-only evidence statement against the selected target. */
export function readRecoveryEvidence(
  repositoryRoot: string,
  target: RecoverySourceTarget,
  scratchDirectory: string,
): RecoveryEvidenceSnapshot {
  const sqlFile = path.join(scratchDirectory, 'recovery-evidence.sql');
  fs.mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sqlFile, buildRecoveryEvidenceSql(), { encoding: 'utf8', mode: 0o600 });
  let output: string;
  try {
    output = execFileSync(process.execPath, [
      cliShim(repositoryRoot),
      'db', 'query', ...targetFlags(target), '-o', 'json', '-f', sqlFile,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit'],
      timeout: EVIDENCE_QUERY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: restrictedCliEnvironment(target),
    });
  } catch {
    throw new RecoveryGuardError('RECOVERY_EVIDENCE_QUERY_FAILED');
  } finally {
    fs.rmSync(sqlFile, { force: true });
  }
  const parsed = parseCliJson(output) as { rows?: Array<{ doc?: unknown }>; error?: unknown }
    | Array<{ doc?: unknown }>;
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if ((!Array.isArray(parsed) && parsed.error) || !Array.isArray(rows) || rows.length !== 1) {
    throw new RecoveryGuardError('RECOVERY_EVIDENCE_QUERY_FAILED');
  }
  return parseRecoveryEvidence(rows[0]?.doc);
}

/**
 * Runs the repository Gate 4 collector against the source through the same read-only channel, so
 * a hosted capture records structural evidence without ever needing a database password.
 */
export function readGate4SourceEvidence(
  repositoryRoot: string,
  target: RecoverySourceTarget,
): unknown {
  const collector = path.join(repositoryRoot, 'infra', 'supabase', 'gate4-schema-evidence.sql');
  const collectorSql = fs.readFileSync(collector, 'utf8');
  const withoutCommentsAndStrings = collectorSql
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ');
  if (!/^\s*(?:with|select)\b/i.test(withoutCommentsAndStrings)
    || /;\s*\S/.test(withoutCommentsAndStrings)
    || /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do)\b/i
      .test(withoutCommentsAndStrings)) {
    throw new RecoveryGuardError('GATE4_SOURCE_EVIDENCE_NOT_READ_ONLY');
  }
  let output: string;
  try {
    output = execFileSync(process.execPath, [
      cliShim(repositoryRoot), 'db', 'query', ...targetFlags(target), '-o', 'json', '-f', collector,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit'],
      timeout: EVIDENCE_QUERY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: restrictedCliEnvironment(target),
    });
  } catch {
    throw new RecoveryGuardError('GATE4_SOURCE_EVIDENCE_QUERY_FAILED');
  }
  const parsed = parseCliJson(output) as { rows?: Array<Record<string, unknown>>; error?: unknown }
    | Array<Record<string, unknown>>;
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if ((!Array.isArray(parsed) && parsed.error) || !Array.isArray(rows) || rows.length !== 1) {
    throw new RecoveryGuardError('GATE4_SOURCE_EVIDENCE_QUERY_FAILED');
  }
  const evidence = rows[0]?.gate4_evidence;
  if (evidence === undefined) throw new RecoveryGuardError('GATE4_SOURCE_EVIDENCE_QUERY_FAILED');
  return evidence;
}

export interface DumpOptions {
  repositoryRoot: string;
  target: RecoverySourceTarget;
  databaseDirectory: string;
  /**
   * Storage tables observed at the source. Storage state is rebuilt through the Storage API, and
   * several of these internal tables are not writable by the `postgres` role on restore, so the
   * whole schema is excluded from the logical data backup.
   */
  storageTables: readonly string[];
}

function runDump(
  repositoryRoot: string,
  target: RecoverySourceTarget,
  args: string[],
  outputFile: string,
): void {
  try {
    execFileSync(process.execPath, [
      cliShim(repositoryRoot), 'db', 'dump', ...targetFlags(target), ...args, '-f', outputFile,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      // stdin stays attached so the CLI can request a hosted database password privately; stdout is
      // discarded because the dump is written to the file, never to the log.
      stdio: ['inherit', 'ignore', 'inherit'],
      timeout: DUMP_TIMEOUT_MS,
      env: restrictedCliEnvironment(target),
    });
  } catch {
    throw new RecoveryGuardError(`DATABASE_DUMP_FAILED:${path.basename(outputFile)}`);
  }
}

/** Captures the official logical-backup artifact set in the order the restore replays them. */
export function dumpDatabaseArtifacts(options: DumpOptions): void {
  const { repositoryRoot, target, databaseDirectory, storageTables } = options;
  fs.mkdirSync(databaseDirectory, { recursive: true });
  const file = (name: string): string => path.join(databaseDirectory, name);
  const excludeStorage = storageTables.flatMap((table) => {
    if (!/^[a-z0-9_]+$/.test(table)) throw new RecoveryGuardError('STORAGE_TABLE_NAME_UNSAFE');
    return ['-x', `storage.${table}`];
  });

  runDump(repositoryRoot, target, ['--role-only'], file('roles.sql'));
  runDump(repositoryRoot, target, [], file('schema.sql'));
  runDump(repositoryRoot, target, ['--schema', 'supabase_migrations'], file('migrations-schema.sql'));
  runDump(repositoryRoot, target, ['--data-only', '--use-copy', ...excludeStorage], file('data.sql'));
  runDump(
    repositoryRoot,
    target,
    ['--data-only', '--use-copy', '--schema', 'supabase_migrations'],
    file('migrations-data.sql'),
  );

  for (const artifact of DATABASE_BACKUP_ARTIFACTS) {
    const produced = file(artifact);
    if (!fs.existsSync(produced) || fs.statSync(produced).size === 0) {
      throw new RecoveryGuardError(`DATABASE_DUMP_EMPTY:${artifact}`);
    }
  }
}
