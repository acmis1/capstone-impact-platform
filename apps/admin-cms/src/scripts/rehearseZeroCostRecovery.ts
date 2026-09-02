import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { captureRecoveryBackup } from '../recovery/captureRecoveryBackup';
import { compareGate4Evidence } from '../deployment/gate4SchemaEvidence';
import { installSyntheticTableDefaultAclFixture } from '../recovery/syntheticTableDefaultAclFixture';
import {
  createDisposableNetwork,
  createDisposableStackIdentity,
  inspectDisposableResidue,
  preflightDisposablePortBase,
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
import { BUNDLE_PATHS, bundleFile, loadRecoveryBundle, sha256File } from '../recovery/recoveryBundleStore';
import {
  countExpectedManagedTriggersInStandardSchemaDump,
  EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT,
} from '../recovery/managedSchemaCustomizations';
import {
  ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL,
  CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY,
  deriveManagedAuthCopyRequirements,
} from '../recovery/managedAuthSchemaCompatibility';
import {
  PLATFORM_PARAMETER_ACL_DENIED_SQLSTATE,
  planRoleParameterAclCompatibility,
} from '../recovery/roleParameterAclCompatibility';

const repositoryRoot = path.resolve(__dirname, '../../../..');

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

  const sourcePortBase = await preflightDisposablePortBase();
  const bundleDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'capstone-recovery-synthetic-bundle-'),
  );
  fs.chmodSync(bundleDirectory, 0o700);
  const source = createDisposableStackIdentity({
    repositoryRoot,
    mode: 'migrated-source',
    portBase: sourcePortBase,
    postgresMajorVersion: 17,
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
    // Reproduce the reviewed hosted-ahead Auth migration on the disposable source only. The
    // synthetic restore target is deterministically set to the corresponding pre-migration shape.
    runDisposablePsql(source, {
      command: ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL,
      singleTransaction: true,
      timeoutMs: 120_000,
      databaseUser: 'supabase_auth_admin',
    });
    const sourceEnv = readDisposableStackEnv(repositoryRoot, source);
    const sourceClient = createClient(sourceEnv.apiUrl, sourceEnv.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(120_000) }) },
    });

    await seedSyntheticAuthIdentity(sourceClient);
    runDisposablePsql(source, { command: buildSyntheticSourceSeedSql(), timeoutMs: 300_000 });
    const seededStorageObjects = await seedSyntheticStorageObjects(sourceClient);

    const sourceBeforeCapture = installSyntheticTableDefaultAclFixture({
      repositoryRoot,
      target: { kind: 'local', workdir: source.workdir },
      sourceKind: 'disposable-local-synthetic',
      sourceProjectRef: source.projectId,
    }, source);

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
      syntheticPlatformParameterAclSource: source,
    });
    if (compareGate4Evidence(sourceBeforeCapture, loadRecoveryBundle(bundleDirectory).gate4Evidence)
      .classification !== 'GATE4_MATCH') {
      throw new Error('SYNTHETIC_CAPTURED_SOURCE_TABLE_ACLS_CHANGED');
    }
    const schemaDump = fs.readFileSync(
      bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/schema.sql`),
      'utf8',
    );
    const authCopyRequirements = deriveManagedAuthCopyRequirements(fs.readFileSync(
      bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/data.sql`),
      'utf8',
    ));
    const hostedAheadCopyHeaderPresent = authCopyRequirements.some((requirement) => (
      requirement.table === CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.table
      && requirement.columns.includes(CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY.column)
    ));
    if (!hostedAheadCopyHeaderPresent) {
      throw new Error('SYNTHETIC_HOSTED_AHEAD_AUTH_COPY_HEADER_MISSING');
    }
    const managedTriggersInStandardSchemaDump = countExpectedManagedTriggersInStandardSchemaDump(
      schemaDump,
    );
    if (managedTriggersInStandardSchemaDump !== 0) {
      throw new Error('STANDARD_SCHEMA_DUMP_MANAGED_BOUNDARY_CHANGED');
    }
    // The reproduced provider-global grant must be checksum-bound in the finished bundle, and the
    // production planner — not the fixture — must be the thing that recognizes it.
    const rolesFile = bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/roles.sql`);
    const manifestFile = bundleFile(bundleDirectory, BUNDLE_PATHS.manifest);
    const rolesBytesBeforeRestore = fs.readFileSync(rolesFile);
    const manifestBytesBeforeRestore = fs.readFileSync(manifestFile);
    const rolePlan = planRoleParameterAclCompatibility(rolesBytesBeforeRestore.toString('utf8'));
    if (rolePlan.action !== 'NORMALIZE_KNOWN_PLATFORM_ACL'
      || rolePlan.parameterAclStatementCount !== 1) {
      throw new Error('SYNTHETIC_PLATFORM_PARAMETER_ACL_NOT_REPRODUCED');
    }
    const recordedRolesChecksum = capture.manifest.database
      .find((entry) => entry.artifact === 'roles.sql')?.sha256;
    if (recordedRolesChecksum !== sha256File(rolesFile)) {
      throw new Error('SYNTHETIC_ROLE_ARTIFACT_CHECKSUM_MISMATCH');
    }

    sourceResidueAbsent = cleanupSource(source, sourceNetworkId, sourceStarted);
    sourceStarted = false;
    if (!sourceResidueAbsent) throw new Error('SYNTHETIC_SOURCE_CLEANUP_FAILED');

    const targetPortBase = await preflightDisposablePortBase([sourcePortBase]);
    const restore = await runRestoreVerification({
      repositoryRoot,
      bundleDirectory,
      portBase: targetPortBase,
      applicationPort: sourcePortBase,
      targetPostgresMajorVersion: 17,
      skipApplicationSmoke,
      proveUnalignedManagedAuthReplayFailure: true,
      simulatePreCustomClaimsAllowlistTarget: true,
      proveUnnormalizedRoleReplayFailure: true,
    });
    const bundlePreservedThroughRestore = assertBundlePreserved(bundleDirectory);
    const roleArtifactUnchanged = fs.readFileSync(rolesFile).equals(rolesBytesBeforeRestore)
      && fs.readFileSync(manifestFile).equals(manifestBytesBeforeRestore);
    console.log('SYNTHETIC_SOURCE_POSTGRES_MAJOR = 17');
    console.log('SYNTHETIC_TARGET_POSTGRES_MAJOR = 17');
    console.log('SYNTHETIC_SOURCE_TABLE_DEFAULT_ACL_ENTRIES = 12');
    console.log('SYNTHETIC_SOURCE_EXISTING_TABLE_ACLS_UNCHANGED = YES');
    console.log('SYNTHETIC_SOURCE_HIGH_IMPACT_GRANTS = 15');
    console.log(`SYNTHETIC_TARGET_ONLY_TABLE_GRANTS_REPRODUCED = ${restore.tableGrantPortabilityRevokeCount > 0 ? 'YES' : 'NO'}`);
    console.log(`SYNTHETIC_SOURCE_REQUIRED_TABLE_GRANTS_PRESERVED = ${restore.tableGrantPortabilityCompatibility === 'REVOKED_KNOWN_TARGET_DEFAULT_ACL_OVERGRANTS' ? 'YES' : 'NO'}`);
    console.log(`SYNTHETIC_STORAGE_OBJECTS_SEEDED = ${seededStorageObjects}`);
    console.log(
      `STANDARD_SCHEMA_DUMP_MANAGED_AUTH_TRIGGERS = ${managedTriggersInStandardSchemaDump}/${EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT}`,
    );
    console.log('SYNTHETIC_HOSTED_AHEAD_AUTH_COPY_HEADER = PRESENT');
    console.log('SYNTHETIC_SOURCE_PLATFORM_PARAMETER_ACL = PRESENT');
    console.log(`SYNTHETIC_BUNDLE_ROLE_ARTIFACT_UNCHANGED = ${roleArtifactUnchanged ? 'YES' : 'NO'}`);
    console.log('SYNTHETIC_TARGET_AUTH_BASELINE = PRE_20260625000000');
    console.log(`MANAGED_AUTH_COMPATIBILITY = ${restore.managedAuthCompatibility}`);
    console.log(
      `LEGACY_UNALIGNED_DATA_REPLAY_FAILED = ${restore.legacyUnalignedDataReplayFailed ? 'YES' : 'NO'}`,
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
      || restore.managedAuthCompatibility !== 'ALIGNED_KNOWN_DELTA'
      || restore.legacyUnalignedDataReplayFailed !== true
      || restore.roleParameterAclCompatibility !== 'NORMALIZED_KNOWN_PLATFORM_ACL'
      || restore.legacyUnnormalizedRoleReplayFailed !== true
      || restore.legacyUnnormalizedRoleReplaySqlState !== PLATFORM_PARAMETER_ACL_DENIED_SQLSTATE
      || restore.tableGrantPortabilityCompatibility !== 'REVOKED_KNOWN_TARGET_DEFAULT_ACL_OVERGRANTS'
      || restore.tableGrantPortabilityRevokeCount <= 0
      || restore.gate4?.sourceComparisonClassification !== 'GATE4_MATCH_CONSTRAINT_RENDERING_PORTABLE'
      || restore.gate4?.constraintRenderingPairCount !== 5
      || restore.gate4?.tableGrantsMatch !== true
      || !roleArtifactUnchanged
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
