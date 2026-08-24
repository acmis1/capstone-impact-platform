import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { EXPECTED_BUCKETS } from '../local-development/localSupabaseFixtures';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { configuredProjectId, observeLocalStack } from '../local-development/localStackState';

const DATABASE_PAYLOAD = 'synthetic-local-recovery-payload';
const DATABASE_SCHEMA_PREFIX = 'capstone_recovery_probe_';
const STORAGE_BUCKET_PREFIX = 'capstone-recovery-probe-';
const MAX_STORAGE_LIST_PAGES = 100;
const STORAGE_LIST_PAGE_SIZE = 100;

export interface DatabaseProbeCommands {
  psql(sql: string): string;
  dumpSchema(schemaName: string): Buffer;
  restoreSchema(dump: Buffer): void;
}

export interface DatabaseProbeResult {
  dumpBytes: number;
  restoredRows: number;
  residueAbsent: boolean;
}

export interface StorageProbeResult {
  backedUpObjects: number;
  restoredObjects: number;
  residueAbsent: boolean;
  canonicalBucketsUnchanged: boolean;
}

export interface LocalRecoveryReadinessResult {
  database: DatabaseProbeResult;
  storage: StorageProbeResult;
}

interface StorageBackupEntry {
  path: string;
  contentType: string;
  content: Buffer;
  checksum: string;
}

interface StorageListEntry {
  name: string;
  id?: string | null;
}

interface StorageListApi {
  list(
    prefix: string,
    options: { limit: number; offset: number; sortBy: { column: string; order: 'asc' } },
  ): Promise<{ data: StorageListEntry[] | null; error: unknown }>;
}

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function assertSafeDatabaseProbeSchema(schemaName: string): void {
  if (!new RegExp(`^${DATABASE_SCHEMA_PREFIX}[a-f0-9]{16}$`).test(schemaName)) {
    throw new Error('UNSAFE_DATABASE_PROBE_SCHEMA');
  }
}

export function assertSafeStorageProbeBucket(bucketName: string): void {
  if (!new RegExp(`^${STORAGE_BUCKET_PREFIX}[a-f0-9]{16}$`).test(bucketName)) {
    throw new Error('UNSAFE_STORAGE_PROBE_BUCKET');
  }
}

export function assertSafeStorageObjectPath(objectPath: string): void {
  const segments = objectPath.split('/');
  if (
    objectPath.length === 0 ||
    objectPath.length > 1_024 ||
    objectPath.includes('\\') ||
    objectPath.startsWith('/') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('UNSAFE_STORAGE_OBJECT_PATH');
  }
}

export function validateRecoveryPreflight(input: {
  stackState: ReturnType<typeof observeLocalStack>;
  apiUrl: string;
  serviceRoleKey: string;
  projectId: string | null;
}): { databaseContainer: string } {
  if (input.stackState !== 'RUNNING') throw new Error('LOCAL_SUPABASE_NOT_READY');
  if (!input.apiUrl || !isLoopbackUrl(input.apiUrl)) throw new Error('NON_LOOPBACK_SUPABASE_REJECTED');
  if (!input.serviceRoleKey) throw new Error('LOCAL_SERVICE_ROLE_KEY_UNAVAILABLE');
  if (!input.projectId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.projectId)) {
    throw new Error('LOCAL_PROJECT_ID_INVALID');
  }
  return { databaseContainer: `supabase_db_${input.projectId}` };
}

function quotedIdentifier(identifier: string): string {
  assertSafeDatabaseProbeSchema(identifier);
  return `"${identifier}"`;
}

export function runDatabaseRecoveryProbeWithCommands(
  schemaName: string,
  commands: DatabaseProbeCommands,
): DatabaseProbeResult {
  const schema = quotedIdentifier(schemaName);
  const checksum = sha256(Buffer.from(DATABASE_PAYLOAD, 'utf8'));
  let failure: Error | undefined;
  let cleanupFailure = false;
  let result: DatabaseProbeResult | undefined;
  let cleanupAuthorized = false;

  const initialState = commands.psql(
    `SELECT CASE WHEN to_regnamespace('${schemaName}') IS NULL THEN 'ABSENT' ELSE 'PRESENT' END;`,
  ).trim();
  if (initialState !== 'ABSENT') throw new Error('DATABASE_PROBE_COLLISION');

  try {
    cleanupAuthorized = true;
    commands.psql([
      `CREATE SCHEMA ${schema};`,
      `CREATE TABLE ${schema}.recovery_evidence (` +
        'id integer PRIMARY KEY, ' +
        'payload text NOT NULL CHECK (btrim(payload) <> \'\'), ' +
        'checksum text NOT NULL CHECK (checksum ~ \'^[a-f0-9]{64}$\')' +
      ');',
      `INSERT INTO ${schema}.recovery_evidence (id, payload, checksum) ` +
        `VALUES (1, '${DATABASE_PAYLOAD}', '${checksum}');`,
    ].join(' '));

    const dump = commands.dumpSchema(schemaName);
    if (dump.length < 100 || dump.subarray(0, 5).toString('ascii') !== 'PGDMP') {
      throw new Error('DATABASE_BACKUP_ARTIFACT_INVALID');
    }

    commands.psql(`DROP SCHEMA ${schema} CASCADE;`);
    commands.restoreSchema(dump);

    const restored = commands.psql(
      `SELECT id::text || '|' || payload || '|' || checksum FROM ${schema}.recovery_evidence ORDER BY id;`,
    ).trim();
    if (restored !== `1|${DATABASE_PAYLOAD}|${checksum}`) {
      throw new Error('DATABASE_RESTORE_VERIFICATION_FAILED');
    }

    result = { dumpBytes: dump.length, restoredRows: 1, residueAbsent: false };
  } catch {
    failure = new Error('DATABASE_BACKUP_RESTORE_FAILED');
  } finally {
    if (cleanupAuthorized) {
      try {
        commands.psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
        const finalState = commands.psql(
          `SELECT CASE WHEN to_regnamespace('${schemaName}') IS NULL THEN 'ABSENT' ELSE 'PRESENT' END;`,
        ).trim();
        cleanupFailure = finalState !== 'ABSENT';
      } catch {
        cleanupFailure = true;
      }
    }
  }

  if (cleanupFailure) throw new Error('DATABASE_PROBE_CLEANUP_FAILED');
  if (failure || !result) throw failure ?? new Error('DATABASE_BACKUP_RESTORE_FAILED');
  return { ...result, residueAbsent: true };
}

export async function listStorageObjectPaths(
  api: StorageListApi,
  prefix = '',
): Promise<string[]> {
  const paths: string[] = [];

  for (let page = 0; page < MAX_STORAGE_LIST_PAGES; page += 1) {
    const { data, error } = await api.list(prefix, {
      limit: STORAGE_LIST_PAGE_SIZE,
      offset: page * STORAGE_LIST_PAGE_SIZE,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error || !data) throw new Error('STORAGE_BACKUP_LIST_FAILED');

    for (const entry of data) {
      const objectPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeStorageObjectPath(objectPath);
      if (entry.id) paths.push(objectPath);
      else paths.push(...await listStorageObjectPaths(api, objectPath));
    }

    if (data.length < STORAGE_LIST_PAGE_SIZE) return paths.sort();
  }

  throw new Error('STORAGE_BACKUP_LIST_LIMIT_EXCEEDED');
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

async function bucketNames(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.storage.listBuckets();
  if (error || !data) throw new Error('STORAGE_BUCKET_INSPECTION_FAILED');
  return sorted(data.map(({ name }) => name));
}

async function assertCanonicalLocalBuckets(client: SupabaseClient): Promise<void> {
  for (const expected of EXPECTED_BUCKETS) {
    const { data, error } = await client.storage.getBucket(expected.name);
    if (error || !data) throw new Error('CANONICAL_STORAGE_BUCKET_MISSING');
    const allowedMimeTypes = sorted(data.allowed_mime_types ?? []);
    if (
      data.public !== expected.isPublic ||
      Number(data.file_size_limit) !== expected.fileSizeLimit ||
      allowedMimeTypes.join('|') !== sorted(expected.allowedMimeTypes).join('|')
    ) {
      throw new Error('CANONICAL_STORAGE_BUCKET_CONFIG_MISMATCH');
    }
  }
}

async function removeProbeBucket(client: SupabaseClient, bucketName: string): Promise<void> {
  assertSafeStorageProbeBucket(bucketName);
  const names = await bucketNames(client);
  if (!names.includes(bucketName)) return;
  const emptied = await client.storage.emptyBucket(bucketName);
  if (emptied.error) throw new Error('STORAGE_PROBE_EMPTY_FAILED');
  const deleted = await client.storage.deleteBucket(bucketName);
  if (deleted.error) throw new Error('STORAGE_PROBE_DELETE_FAILED');
}

async function createProbeBucket(client: SupabaseClient, bucketName: string): Promise<void> {
  assertSafeStorageProbeBucket(bucketName);
  const { error } = await client.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: 1024 * 1024,
    allowedMimeTypes: ['application/json', 'application/octet-stream'],
  });
  if (error) throw new Error('STORAGE_PROBE_CREATE_FAILED');
}

async function uploadStorageEntries(
  client: SupabaseClient,
  bucketName: string,
  entries: StorageBackupEntry[],
): Promise<void> {
  for (const entry of entries) {
    assertSafeStorageObjectPath(entry.path);
    const { error } = await client.storage.from(bucketName).upload(entry.path, entry.content, {
      contentType: entry.contentType,
      upsert: false,
    });
    if (error) throw new Error('STORAGE_PROBE_UPLOAD_FAILED');
  }
}

async function backupStorageEntries(
  client: SupabaseClient,
  bucketName: string,
): Promise<StorageBackupEntry[]> {
  const paths = await listStorageObjectPaths(client.storage.from(bucketName));
  const entries: StorageBackupEntry[] = [];
  for (const objectPath of paths) {
    const { data, error } = await client.storage.from(bucketName).download(objectPath);
    if (error || !data) throw new Error('STORAGE_BACKUP_DOWNLOAD_FAILED');
    const content = Buffer.from(await data.arrayBuffer());
    entries.push({
      path: objectPath,
      contentType: data.type || 'application/octet-stream',
      content,
      checksum: sha256(content),
    });
  }
  return entries;
}

async function verifyStorageRestore(
  client: SupabaseClient,
  bucketName: string,
  expected: StorageBackupEntry[],
): Promise<void> {
  const restoredPaths = await listStorageObjectPaths(client.storage.from(bucketName));
  if (restoredPaths.join('|') !== sorted(expected.map(({ path: objectPath }) => objectPath)).join('|')) {
    throw new Error('STORAGE_RESTORE_OBJECT_SET_MISMATCH');
  }

  for (const entry of expected) {
    const { data, error } = await client.storage.from(bucketName).download(entry.path);
    if (error || !data) throw new Error('STORAGE_RESTORE_DOWNLOAD_FAILED');
    const content = Buffer.from(await data.arrayBuffer());
    if (content.length !== entry.content.length || sha256(content) !== entry.checksum) {
      throw new Error('STORAGE_RESTORE_CHECKSUM_MISMATCH');
    }
  }
}

export async function runStorageRecoveryProbe(
  client: SupabaseClient,
  bucketName: string,
): Promise<StorageProbeResult> {
  assertSafeStorageProbeBucket(bucketName);
  let failure: Error | undefined;
  let cleanupFailure = false;
  let result: StorageProbeResult | undefined;
  const initialBuckets = await bucketNames(client);

  if (initialBuckets.includes(bucketName)) throw new Error('STORAGE_PROBE_COLLISION');
  await assertCanonicalLocalBuckets(client);

  const fixtureEntries: StorageBackupEntry[] = [
    {
      path: 'evidence/recovery.json',
      contentType: 'application/json',
      content: Buffer.from('{"scope":"synthetic-local-recovery"}\n', 'utf8'),
      checksum: '',
    },
    {
      path: 'payload.bin',
      contentType: 'application/octet-stream',
      content: Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]),
      checksum: '',
    },
  ].map((entry) => ({ ...entry, checksum: sha256(entry.content) }));

  try {
    await createProbeBucket(client, bucketName);
    await uploadStorageEntries(client, bucketName, fixtureEntries);
    const backup = await backupStorageEntries(client, bucketName);
    if (backup.length !== fixtureEntries.length) throw new Error('STORAGE_BACKUP_OBJECT_SET_MISMATCH');

    await removeProbeBucket(client, bucketName);
    await createProbeBucket(client, bucketName);
    await uploadStorageEntries(client, bucketName, backup);
    await verifyStorageRestore(client, bucketName, backup);

    result = {
      backedUpObjects: backup.length,
      restoredObjects: backup.length,
      residueAbsent: false,
      canonicalBucketsUnchanged: false,
    };
  } catch {
    failure = new Error('STORAGE_BACKUP_RESTORE_FAILED');
  } finally {
    try {
      await removeProbeBucket(client, bucketName);
      const finalBuckets = await bucketNames(client);
      cleanupFailure = finalBuckets.includes(bucketName);
      if (!cleanupFailure && finalBuckets.join('|') !== initialBuckets.join('|')) {
        cleanupFailure = true;
      }
    } catch {
      cleanupFailure = true;
    }
  }

  if (cleanupFailure) throw new Error('STORAGE_PROBE_CLEANUP_FAILED');
  if (failure || !result) throw failure ?? new Error('STORAGE_BACKUP_RESTORE_FAILED');
  return { ...result, residueAbsent: true, canonicalBucketsUnchanged: true };
}

function localDatabaseCommands(repoRoot: string, databaseContainer: string): DatabaseProbeCommands {
  const runDocker = (args: string[], options?: { input?: Buffer }): Buffer => execFileSync('docker', args, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...(options?.input ? { input: options.input } : {}),
  });

  return {
    psql(sql) {
      try {
        return runDocker([
          'exec', databaseContainer,
          'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql,
        ]).toString('utf8');
      } catch {
        throw new Error('LOCAL_DATABASE_COMMAND_FAILED');
      }
    },
    dumpSchema(schemaName) {
      assertSafeDatabaseProbeSchema(schemaName);
      try {
        return runDocker([
          'exec', databaseContainer,
          'pg_dump', '-U', 'postgres', '-d', 'postgres',
          '--format=custom', '--no-owner', '--no-privileges', `--schema=${schemaName}`,
        ]);
      } catch {
        throw new Error('LOCAL_DATABASE_BACKUP_FAILED');
      }
    },
    restoreSchema(dump) {
      try {
        runDocker([
          'exec', '-i', databaseContainer,
          'pg_restore', '-U', 'postgres', '-d', 'postgres',
          '--no-owner', '--no-privileges', '--exit-on-error',
        ], { input: dump });
      } catch {
        throw new Error('LOCAL_DATABASE_RESTORE_FAILED');
      }
    },
  };
}

export async function runLocalRecoveryReadiness(
  repoRoot = path.resolve(__dirname, '../../../../'),
): Promise<LocalRecoveryReadinessResult> {
  const projectId = configuredProjectId(repoRoot);
  const cliShim = path.join(repoRoot, 'node_modules', 'supabase', 'dist', 'supabase.js');
  let rawEnvironment = '';
  try {
    rawEnvironment = execFileSync(process.execPath, [
      cliShim, 'status', '--workdir', path.join(repoRoot, 'infra'), '-o', 'env',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('LOCAL_SUPABASE_STATUS_UNAVAILABLE');
  }

  const local = parseSupabaseCliEnv(rawEnvironment);
  const preflight = validateRecoveryPreflight({
    stackState: observeLocalStack(repoRoot),
    apiUrl: local.API_URL ?? '',
    serviceRoleKey: local.SERVICE_ROLE_KEY ?? '',
    projectId,
  });
  const client = createClient(local.API_URL!, local.SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    },
  });
  const token = randomBytes(8).toString('hex');
  const database = runDatabaseRecoveryProbeWithCommands(
    `${DATABASE_SCHEMA_PREFIX}${token}`,
    localDatabaseCommands(repoRoot, preflight.databaseContainer),
  );
  const storage = await runStorageRecoveryProbe(client, `${STORAGE_BUCKET_PREFIX}${token}`);
  return { database, storage };
}

async function main(): Promise<void> {
  try {
    const result = await runLocalRecoveryReadiness();
    console.log('LOCAL_RECOVERY_CLASSIFICATION = VERIFIED');
    console.log(`DATABASE_BACKUP_RESTORE = PASS (${result.database.restoredRows} synthetic row)`);
    console.log(`DATABASE_BACKUP_BYTES = ${result.database.dumpBytes}`);
    console.log(`STORAGE_BACKUP_RESTORE = PASS (${result.storage.restoredObjects} synthetic objects)`);
    console.log('CANONICAL_APPLICATION_TABLES_OR_STORAGE_OBJECTS_MUTATED = NO');
    console.log('RECOVERY_PROBE_RESIDUE = NONE');
    console.log('HOSTED_SYSTEMS_CONTACTED = NO');
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'LOCAL_RECOVERY_READINESS_FAILED');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'verifyLocalRecoveryReadiness.ts') {
  void main();
}
