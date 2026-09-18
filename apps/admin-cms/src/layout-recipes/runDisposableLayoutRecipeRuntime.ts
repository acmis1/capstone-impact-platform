import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';
import {
  assertDatabaseContainerOwned,
  createDisposableNetwork,
  createDisposableStackIdentity,
  inspectDisposableResidue,
  preflightDisposablePortBase,
  removeDisposableResidue,
  residueIsAbsent,
  startDisposableStack,
  stopDisposableStack,
  type DisposableStackIdentity,
} from '../recovery/disposableSupabaseStack';
import {
  seedLayoutRecipeUpgradeBaseline,
  verifyLayoutRecipeRuntime,
  verifyLayoutRecipeUpgradePreservation,
} from './verifyLayoutRecipeRuntime';

const MIGRATION_58_FILE = '20260914100000_layout_recipe_library.sql';
const RELEASE_TAIL_FILES = [
  MIGRATION_58_FILE,
  '20260916120000_archived_project_restore.sql',
  '20260917090000_archived_project_republish_media_rearm.sql',
  '20260917120000_governed_project_soft_delete.sql',
  '20260918120000_governed_project_maintenance.sql',
] as const;

function migrationPaths(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
  migrationFile: (typeof RELEASE_TAIL_FILES)[number],
) {
  const copiedMigrationsDirectory = path.resolve(identity.workdir, 'supabase', 'migrations');
  const copiedMigration = path.resolve(copiedMigrationsDirectory, migrationFile);
  if (path.dirname(copiedMigration) !== copiedMigrationsDirectory || path.basename(copiedMigration) !== migrationFile) {
    throw new Error('LAYOUT_RUNTIME_MIGRATION_PATH_UNSAFE');
  }
  return {
    sourceMigration: path.resolve(repositoryRoot, 'infra', 'supabase', 'migrations', migrationFile),
    copiedMigration,
  };
}

function withholdReleaseTail(repositoryRoot: string, identity: DisposableStackIdentity): void {
  for (const migrationFile of RELEASE_TAIL_FILES) {
    const { sourceMigration, copiedMigration } = migrationPaths(repositoryRoot, identity, migrationFile);
    if (!fs.existsSync(sourceMigration) || !fs.existsSync(copiedMigration)) {
      throw new Error('LAYOUT_RUNTIME_MIGRATION_MISSING');
    }
    fs.rmSync(copiedMigration);
    if (fs.existsSync(copiedMigration)) throw new Error('LAYOUT_RUNTIME_MIGRATION_WITHHOLD_FAILED');
  }
}

function restoreMigration(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
  migrationFile: (typeof RELEASE_TAIL_FILES)[number],
): void {
  const { sourceMigration, copiedMigration } = migrationPaths(repositoryRoot, identity, migrationFile);
  if (!fs.existsSync(sourceMigration) || fs.existsSync(copiedMigration)) {
    throw new Error('LAYOUT_RUNTIME_MIGRATION_RESTORE_UNSAFE');
  }
  fs.copyFileSync(sourceMigration, copiedMigration, fs.constants.COPYFILE_EXCL);
}

function restrictedMigrationEnvironment(extra: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ];
  const childEnvironment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'test' };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  return { ...childEnvironment, ...extra };
}

function applyPendingMigrations(repositoryRoot: string, identity: DisposableStackIdentity, networkId: string): void {
  const proxy = startDockerLoopbackProxy(repositoryRoot);
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      'migration', 'up', '--local', '--workdir', identity.workdir, '--network-id', networkId,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 300_000,
      env: restrictedMigrationEnvironment({
        SUPABASE_TELEMETRY_DISABLED: '1',
        DOCKER_HOST: proxy.dockerHost,
        DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(
          process.env.DOCKER_CUSTOM_HEADERS,
          proxy.authorizationToken,
        ),
      }),
    });
  } finally {
    stopDockerLoopbackProxy(proxy);
  }
}

export async function runDisposableLayoutRecipeRuntime(): Promise<void> {
  const repositoryRoot = path.resolve(__dirname, '../../../..');
  const startedAt = Date.now();
  let identity: DisposableStackIdentity | undefined;
  let networkId = '';
  let startAttempted = false;
  try {
    identity = createDisposableStackIdentity({
      repositoryRoot, mode: 'migrated-source', tag: 'layout',
      portBase: await preflightDisposablePortBase(), postgresMajorVersion: 17,
    });
    withholdReleaseTail(repositoryRoot, identity);
    networkId = createDisposableNetwork(identity);
    startAttempted = true;
    startDisposableStack(repositoryRoot, identity, networkId);
    assertDatabaseContainerOwned(identity);
    const baseline = await seedLayoutRecipeUpgradeBaseline(repositoryRoot, identity);
    restoreMigration(repositoryRoot, identity, MIGRATION_58_FILE);
    applyPendingMigrations(repositoryRoot, identity, networkId);
    await verifyLayoutRecipeUpgradePreservation(repositoryRoot, identity, baseline);
    restoreMigration(repositoryRoot, identity, RELEASE_TAIL_FILES[1]);
    restoreMigration(repositoryRoot, identity, RELEASE_TAIL_FILES[2]);
    restoreMigration(repositoryRoot, identity, RELEASE_TAIL_FILES[3]);
    restoreMigration(repositoryRoot, identity, RELEASE_TAIL_FILES[4]);
    applyPendingMigrations(repositoryRoot, identity, networkId);
    await verifyLayoutRecipeRuntime(repositoryRoot, identity);
    console.log('PASS: exact retained-state 57 -> 58 preservation and current M62 layout recipe runtime');
  } catch (error) {
    console.error('FAIL: layout recipe disposable runtime');
    if (error instanceof Error && error.message.startsWith('LAYOUT_RUNTIME_')) console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (identity && startAttempted) {
      try { stopDisposableStack(repositoryRoot, identity, networkId); }
      catch { /* Exact-identity cleanup below is authoritative. */ }
    }
    if (identity) {
      try {
        removeDisposableResidue(identity);
        if (!residueIsAbsent(inspectDisposableResidue(identity))) throw new Error('RESIDUE');
        console.log('PASS: disposable containers, volumes, network and workdir removed');
      } catch {
        console.error('FAIL: disposable cleanup or residue verification');
        process.exitCode = 1;
      }
    }
    console.log(`Layout recipe elapsed seconds: ${Math.ceil((Date.now() - startedAt) / 1000)}`);
  }
}

if (require.main === module) void runDisposableLayoutRecipeRuntime().catch(() => {
  console.error('FAIL: layout recipe disposable preflight');
  process.exitCode = 1;
});
