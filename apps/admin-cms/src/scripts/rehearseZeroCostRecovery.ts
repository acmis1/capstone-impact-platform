import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { captureRecoveryBackup } from '../recovery/captureRecoveryBackup';
import {
  createDisposableNetwork,
  createDisposableStackIdentity,
  inspectDisposableResidue,
  readDisposableStackEnv,
  removeDisposableResidue,
  residueIsAbsent,
  runDisposablePsql,
  startDisposableStack,
  stopDisposableStack,
  type DisposableStackIdentity,
} from '../recovery/disposableSupabaseStack';
import {
  assertBundlePreserved,
  runRestoreVerification,
} from '../recovery/restoreRecoveryRehearsal';
import {
  buildSyntheticSourceSeedSql,
  seedSyntheticAuthIdentity,
  seedSyntheticStorageObjects,
} from '../recovery/syntheticSourceEvidence';
import { formatRestoreSummary } from './restoreRecoveryBackup';
import { BUNDLE_PATHS, bundleFile } from '../recovery/recoveryBundleStore';
import {
  countExpectedManagedTriggersInStandardSchemaDump,
  EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT,
} from '../recovery/managedSchemaCustomizations';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const SOURCE_PORT_BASE = 54_820;
const TARGET_PORT_BASE = 54_940;
const APPLICATION_PORT = 3_017;

function removeSyntheticBundle(bundleDirectory: string): void {
  const resolved = path.resolve(bundleDirectory);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(resolved).startsWith('capstone-recovery-synthetic-bundle-')) {
    throw new Error('SYNTHETIC_BUNDLE_OWNERSHIP_UNPROVEN');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function cleanupSource(
  identity: DisposableStackIdentity,
  networkId: string,
  started: boolean,
): boolean {
  if (started) {
    try {
      stopDisposableStack(repositoryRoot, identity, networkId);
    } catch {
      // Exact-identity cleanup below remains authoritative.
    }
  }
  try {
    removeDisposableResidue(identity);
  } catch {
    return false;
  }
  try {
    return residueIsAbsent(inspectDisposableResidue(identity));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const skipApplicationSmoke = process.argv.slice(2).includes('--skip-application-smoke');
  if (process.argv.slice(2).some((argument) => argument !== '--skip-application-smoke')) {
    console.error('SYNTHETIC_RECOVERY_CLASSIFICATION = ARGUMENTS_INVALID');
    process.exitCode = 1;
    return;
  }

  const bundleDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'capstone-recovery-synthetic-bundle-'),
  );
  fs.chmodSync(bundleDirectory, 0o700);
  const source = createDisposableStackIdentity({
    repositoryRoot,
    mode: 'migrated-source',
    portBase: SOURCE_PORT_BASE,
    postgresMajorVersion: 15,
    tag: 'source',
  });
  let sourceNetworkId = '';
  let sourceStarted = false;
  let sourceResidueAbsent = false;
  let syntheticBundleCleaned = false;

  try {
    sourceNetworkId = createDisposableNetwork(source);
    startDisposableStack(repositoryRoot, source, sourceNetworkId);
    sourceStarted = true;
    const sourceEnv = readDisposableStackEnv(repositoryRoot, source);
    const sourceClient = createClient(sourceEnv.apiUrl, sourceEnv.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(120_000) }) },
    });

    await seedSyntheticAuthIdentity(sourceClient);
    runDisposablePsql(source, { command: buildSyntheticSourceSeedSql(), timeoutMs: 300_000 });
    const seededStorageObjects = await seedSyntheticStorageObjects(sourceClient);

    const capture = await captureRecoveryBackup({
      repositoryRoot,
      target: { kind: 'local', workdir: source.workdir },
      sourceKind: 'disposable-local-synthetic',
      sourceProjectRef: source.projectId,
      environmentLabel: 'disposable-local-synthetic',
      outputDirectory: bundleDirectory,
      storageApiUrl: sourceEnv.apiUrl,
      storageServiceKey: sourceEnv.serviceRoleKey,
      scratchDirectory: path.join(source.workdir, 'scratch'),
    });
    const schemaDump = fs.readFileSync(
      bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/schema.sql`),
      'utf8',
    );
    const managedTriggersInStandardSchemaDump = countExpectedManagedTriggersInStandardSchemaDump(
      schemaDump,
    );
    if (managedTriggersInStandardSchemaDump !== 0) {
      throw new Error('STANDARD_SCHEMA_DUMP_MANAGED_BOUNDARY_CHANGED');
    }

    sourceResidueAbsent = cleanupSource(source, sourceNetworkId, sourceStarted);
    sourceStarted = false;
    if (!sourceResidueAbsent) throw new Error('SYNTHETIC_SOURCE_CLEANUP_FAILED');

    const restore = await runRestoreVerification({
      repositoryRoot,
      bundleDirectory,
      portBase: TARGET_PORT_BASE,
      applicationPort: APPLICATION_PORT,
      targetPostgresMajorVersion: 17,
      skipApplicationSmoke,
    });
    const bundlePreservedThroughRestore = assertBundlePreserved(bundleDirectory);
    console.log('SYNTHETIC_SOURCE_POSTGRES_MAJOR = 15');
    console.log('SYNTHETIC_TARGET_POSTGRES_MAJOR = 17');
    console.log(`SYNTHETIC_STORAGE_OBJECTS_SEEDED = ${seededStorageObjects}`);
    console.log(
      `STANDARD_SCHEMA_DUMP_MANAGED_AUTH_TRIGGERS = ${managedTriggersInStandardSchemaDump}/${EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT}`,
    );
    console.log(`BACKUP_DURATION_MS = ${Date.parse(capture.completedAt) - Date.parse(capture.startedAt)}`);
    console.log(`SYNTHETIC_SOURCE_RESIDUE_ABSENT = ${sourceResidueAbsent ? 'YES' : 'NO'}`);
    console.log(formatRestoreSummary(restore, bundlePreservedThroughRestore));

    removeSyntheticBundle(bundleDirectory);
    syntheticBundleCleaned = !fs.existsSync(bundleDirectory);
    console.log(`SYNTHETIC_BUNDLE_CLEANED = ${syntheticBundleCleaned ? 'YES' : 'NO'}`);
    console.log('HOSTED_CONTACT = NO');
    console.log('PAID_SERVICE_DEPENDENCY = NO');

    if (restore.classification !== 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED'
      || !bundlePreservedThroughRestore
      || !syntheticBundleCleaned) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('SYNTHETIC_RECOVERY_CLASSIFICATION = FAILED');
    console.error(`SYNTHETIC_RECOVERY_FAILURE = ${error instanceof Error ? error.message : 'UNKNOWN'}`);
    process.exitCode = 1;
  } finally {
    if (!sourceResidueAbsent) sourceResidueAbsent = cleanupSource(source, sourceNetworkId, sourceStarted);
    if (fs.existsSync(bundleDirectory)) {
      try {
        removeSyntheticBundle(bundleDirectory);
        syntheticBundleCleaned = !fs.existsSync(bundleDirectory);
      } catch {
        syntheticBundleCleaned = false;
      }
    }
    if (!sourceResidueAbsent || !syntheticBundleCleaned) process.exitCode = 1;
  }
}

void main();
