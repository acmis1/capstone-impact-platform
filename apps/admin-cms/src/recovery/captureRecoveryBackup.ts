import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { validateCurrentRepositoryGate4Contract } from '../deployment/gate4SchemaEvidence';
import {
  sha256,
  summarizeBuckets,
  validateRecoveryBundleManifest,
  type RecoveryBundleManifest,
  type RecoverySourceKind,
  type StorageObjectRecord,
} from './recoveryBundle';
import {
  BUNDLE_PATHS,
  PRIVATE_OBJECT_MANIFEST_FORMAT,
  assertOperatorBackupDirectory,
  bundleFile,
  sha256File,
  writeJsonArtifact,
  writeStorageObject,
  type PrivateObjectManifest,
} from './recoveryBundleStore';
import { serializeTableEvidence } from './recoveryEvidenceSql';
import {
  assertRepositoryManagedSchemaMigrationInventory,
  managedSchemaCustomizationCounts,
  validateManagedSchemaCustomizationsAgainstRepository,
} from './managedSchemaCustomizations';
import {
  assertDatabaseContainerOwned,
  assertDisposableOwnership,
  type DisposableStackIdentity,
} from './disposableSupabaseStack';
import { buildSyntheticPlatformParameterAclRoleDump } from './roleParameterAclCompatibility';
import { iterateBucketObjects, readBucketConfigurations } from './storageTransfer';
import {
  dumpDatabaseArtifacts,
  readGate4SourceEvidence,
  readLinkedProjectRef,
  readManagedSchemaCustomizationEvidence,
  readRecoveryEvidence,
  supabaseCliVersion,
  type RecoverySourceTarget,
} from './supabaseRecoveryCli';
import {
  APPROVED_HOSTED_SOURCE_PROJECT_REF,
  CANONICAL_STORAGE_BUCKETS,
  DATABASE_BACKUP_ARTIFACTS,
  RECOVERY_BUNDLE_FORMAT,
  RECOVERY_EVIDENCE_LABEL,
  RecoveryGuardError,
  assertApprovedHostedCaptureTarget,
} from './zeroCostRecoveryContract';

/**
 * Phase A: read-only capture from a source into an operator-selected bundle directory.
 *
 * Nothing in this phase writes to the source. The database side is the official Supabase logical
 * dump; Storage is listed and downloaded through the Storage API; structural and row-count evidence
 * comes from a single read-only statement.
 */

export interface CaptureOptions {
  repositoryRoot: string;
  target: RecoverySourceTarget;
  sourceKind: RecoverySourceKind;
  sourceProjectRef: string;
  environmentLabel: string;
  outputDirectory: string;
  /** Storage API endpoint and service credential for the source. Never logged, never persisted. */
  storageApiUrl: string;
  storageServiceKey: string;
  scratchDirectory: string;
  /**
   * Synthetic-only reproduction of the hosted platform `pg_parameter_acl` grant inside the role
   * dump. Only a superuser can create that cluster-global state, so a disposable local source
   * cannot produce it naturally. It is applied before any manifest checksum exists, keeping the
   * synthetic bundle checksum-valid so it reaches the real production restore path.
   *
   * The evidence is structural, never a flag or a name: this must be the running
   * rehearsal-created disposable stack the capture is reading, proven by the same ownership
   * machinery that guards every other disposable operation. An operator Local stack, a
   * caller-chosen project name, and a caller-chosen `sourceKind` cannot satisfy it, so no real
   * capture can reach the fixture. Never accepted for a hosted source.
   */
  syntheticPlatformParameterAclSource?: DisposableStackIdentity;
}

export interface CaptureResult {
  bundleDirectory: string;
  manifest: RecoveryBundleManifest;
  objectCount: number;
  startedAt: string;
  completedAt: string;
}

function reviewedRepositoryGitSha(repositoryRoot: string, requireCleanTrackedCheckout: boolean): string {
  if (requireCleanTrackedCheckout) {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    if (status.trim()) throw new RecoveryGuardError('REPOSITORY_TRACKED_CHANGES_PRESENT');
  }
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new RecoveryGuardError('REPOSITORY_GIT_SHA_INVALID');
  return sha;
}

export function repositoryMigrationVersions(repositoryRoot: string): string[] {
  return fs.readdirSync(path.join(repositoryRoot, 'infra', 'supabase', 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const version = /^(\d{14})_/.exec(file)?.[1];
      if (!version) throw new RecoveryGuardError('REPOSITORY_MIGRATION_FILENAME_INVALID');
      return version;
    })
    .sort();
}

/**
 * Proves the synthetic role fixture belongs to a running verifier-owned disposable source before
 * anything is captured.
 *
 * A caller-selected `sourceKind`, project name, or loopback endpoint says only what the caller
 * claims. This instead requires the disposable stack itself: the capture must be reading exactly
 * that stack's workdir under the temporary root, carrying its ownership marker, named with the
 * rehearsal project id, and backed by a running database container the Supabase CLI labelled with
 * the same id. An ordinary operator Local stack satisfies none of that, so it cannot activate the
 * fixture, and the check runs before the bundle directory, any dump, or any checksum exists.
 */
function assertSyntheticPlatformParameterAclSource(
  options: CaptureOptions,
  identity: DisposableStackIdentity,
): void {
  if (options.sourceKind !== 'disposable-local-synthetic' || options.target.kind !== 'local') {
    throw new RecoveryGuardError('SYNTHETIC_PLATFORM_PARAMETER_ACL_PRECONDITION_FAILED');
  }
  if (path.resolve(options.target.workdir) !== path.resolve(identity.workdir)
    || options.sourceProjectRef !== identity.projectId) {
    throw new RecoveryGuardError('SYNTHETIC_PLATFORM_PARAMETER_ACL_SOURCE_NOT_OWNED');
  }
  try {
    assertDisposableOwnership(identity);
    assertDatabaseContainerOwned(identity);
  } catch {
    // Ownership failures carry resource identity, so only the fixed refusal is surfaced.
    throw new RecoveryGuardError('SYNTHETIC_PLATFORM_PARAMETER_ACL_SOURCE_NOT_OWNED');
  }
}

/** Runs the complete read-only capture and writes the bundle. */
export async function captureRecoveryBackup(options: CaptureOptions): Promise<CaptureResult> {
  const startedAt = new Date().toISOString();
  if (options.sourceKind === 'hosted-staging') {
    if (options.target.kind !== 'hosted-linked') throw new RecoveryGuardError('HOSTED_CAPTURE_TARGET_KIND_INVALID');
    assertApprovedHostedCaptureTarget({
      requestedProjectRef: options.sourceProjectRef,
      linkedProjectRef: readLinkedProjectRef(options.target.workdir),
    });
    if (options.storageApiUrl !== `https://${APPROVED_HOSTED_SOURCE_PROJECT_REF}.supabase.co`) {
      throw new RecoveryGuardError('SOURCE_STORAGE_ENDPOINT_NOT_APPROVED');
    }
  } else {
    if (options.target.kind !== 'local') throw new RecoveryGuardError('SYNTHETIC_CAPTURE_TARGET_KIND_INVALID');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/.test(options.storageApiUrl)) {
      throw new RecoveryGuardError('SYNTHETIC_STORAGE_ENDPOINT_NOT_LOOPBACK');
    }
  }
  if (options.syntheticPlatformParameterAclSource !== undefined) {
    assertSyntheticPlatformParameterAclSource(options, options.syntheticPlatformParameterAclSource);
  }
  const reviewedGitSha = reviewedRepositoryGitSha(
    options.repositoryRoot,
    options.sourceKind === 'hosted-staging',
  );
  assertRepositoryManagedSchemaMigrationInventory(options.repositoryRoot);
  const bundleDirectory = assertOperatorBackupDirectory(options.outputDirectory, options.repositoryRoot);
  fs.mkdirSync(bundleDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(bundleDirectory, 0o700);
  // Re-check the now-created directory to close symlink/working-tree races before private bytes land.
  assertOperatorBackupDirectory(bundleDirectory, options.repositoryRoot);
  writeJsonArtifact(bundleDirectory, BUNDLE_PATHS.incompleteMarker, {
    classification: 'PRIVATE_INCOMPLETE_RECOVERY_BUNDLE',
    startedAt,
    handling: 'RETAIN_OR_DESTROY_UNDER_OPERATOR_POLICY_NEVER_COMMIT',
  });

  const evidence = readRecoveryEvidence(options.repositoryRoot, options.target, options.scratchDirectory);
  const managedSchemaEvidence = readManagedSchemaCustomizationEvidence(
    options.repositoryRoot,
    options.target,
    options.scratchDirectory,
  );
  const managedSchemaErrors = validateManagedSchemaCustomizationsAgainstRepository(
    managedSchemaEvidence,
  );
  if (managedSchemaErrors.length > 0) {
    throw new RecoveryGuardError(
      `SOURCE_MANAGED_SCHEMA_CUSTOMIZATION_INVALID:${managedSchemaErrors[0]}`,
    );
  }
  if (evidence.migrationVersions.length === 0) {
    throw new RecoveryGuardError('SOURCE_MIGRATION_HISTORY_UNAVAILABLE');
  }
  if (!evidence.executionControl.schemaPresent || evidence.executionControl.budgetGuard === null) {
    throw new RecoveryGuardError('SOURCE_EXECUTION_CONTROL_STATE_UNAVAILABLE');
  }
  if (evidence.auth.orphanIdentityCount !== 0) {
    throw new RecoveryGuardError('SOURCE_AUTH_RELATIONAL_INTEGRITY_FAILED');
  }

  dumpDatabaseArtifacts({
    repositoryRoot: options.repositoryRoot,
    target: options.target,
    databaseDirectory: bundleFile(bundleDirectory, BUNDLE_PATHS.database),
    storageTables: evidence.storageTables,
  });
  for (const artifact of DATABASE_BACKUP_ARTIFACTS) {
    fs.chmodSync(bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/${artifact}`), 0o600);
  }
  if (options.syntheticPlatformParameterAclSource !== undefined) {
    // Re-proven here so the fixture cannot outlive the source it belongs to, and still ahead of
    // every manifest entry and recorded checksum.
    assertSyntheticPlatformParameterAclSource(options, options.syntheticPlatformParameterAclSource);
    const rolesFile = bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/roles.sql`);
    fs.writeFileSync(
      rolesFile,
      buildSyntheticPlatformParameterAclRoleDump(fs.readFileSync(rolesFile, 'utf8')),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  const client = createClient(options.storageApiUrl, options.storageServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(120_000) }) },
  });

  const bucketConfigurations = (await readBucketConfigurations(client))
    .filter((bucket) => (CANONICAL_STORAGE_BUCKETS as readonly string[]).includes(bucket.id));
  const missing = CANONICAL_STORAGE_BUCKETS.filter(
    (bucket) => !bucketConfigurations.some((candidate) => candidate.id === bucket),
  );
  if (missing.length > 0) throw new RecoveryGuardError('SOURCE_CANONICAL_BUCKET_MISSING');

  const objectRecords: StorageObjectRecord[] = [];
  for (const bucket of CANONICAL_STORAGE_BUCKETS) {
    for await (const object of iterateBucketObjects(client, bucket)) {
      writeStorageObject(bundleDirectory, object);
      objectRecords.push(object.record);
    }
  }
  const privateObjectManifest: PrivateObjectManifest = {
    formatVersion: PRIVATE_OBJECT_MANIFEST_FORMAT,
    classification: 'PRIVATE_RECOVERY_EVIDENCE_NEVER_COMMIT',
    objects: objectRecords,
  };
  const privateObjectManifestChecksum = writeJsonArtifact(
    bundleDirectory,
    BUNDLE_PATHS.privateObjectManifest,
    privateObjectManifest,
  );

  const dataEvidenceFile = bundleFile(bundleDirectory, BUNDLE_PATHS.dataEvidence);
  fs.mkdirSync(path.dirname(dataEvidenceFile), { recursive: true });
  const serializedDataEvidence = serializeTableEvidence(evidence.tables);
  fs.writeFileSync(dataEvidenceFile, serializedDataEvidence, { encoding: 'utf8', mode: 0o600 });

  const managedSchemaChecksum = writeJsonArtifact(
    bundleDirectory,
    BUNDLE_PATHS.managedSchemaCustomizations,
    managedSchemaEvidence,
  );

  const gate4Evidence = readGate4SourceEvidence(options.repositoryRoot, options.target);
  const expectedMigrations = repositoryMigrationVersions(options.repositoryRoot);
  const gate4Errors = validateCurrentRepositoryGate4Contract(gate4Evidence, expectedMigrations);
  if (gate4Errors.length > 0) {
    throw new RecoveryGuardError(`SOURCE_GATE4_CONTRACT_INVALID:${gate4Errors[0]}`);
  }
  const gate4Checksum = writeJsonArtifact(
    bundleDirectory,
    BUNDLE_PATHS.gate4Evidence,
    gate4Evidence,
  );

  const database = DATABASE_BACKUP_ARTIFACTS.map((artifact) => {
    const file = bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/${artifact}`);
    return { artifact, bytes: fs.statSync(file).size, sha256: sha256File(file) };
  });

  const completedGitSha = reviewedRepositoryGitSha(
    options.repositoryRoot,
    options.sourceKind === 'hosted-staging',
  );
  if (completedGitSha !== reviewedGitSha) {
    throw new RecoveryGuardError('REPOSITORY_CHANGED_DURING_CAPTURE');
  }
  const completedEvidence = readRecoveryEvidence(
    options.repositoryRoot,
    options.target,
    options.scratchDirectory,
  );
  const completedManagedSchemaEvidence = readManagedSchemaCustomizationEvidence(
    options.repositoryRoot,
    options.target,
    options.scratchDirectory,
  );
  if (JSON.stringify(completedEvidence) !== JSON.stringify(evidence)
    || JSON.stringify(completedManagedSchemaEvidence) !== JSON.stringify(managedSchemaEvidence)) {
    throw new RecoveryGuardError('SOURCE_CHANGED_DURING_CAPTURE');
  }
  const completedAt = new Date().toISOString();
  const managedCounts = managedSchemaCustomizationCounts(managedSchemaEvidence);
  const manifest: RecoveryBundleManifest = {
    formatVersion: RECOVERY_BUNDLE_FORMAT,
    evidenceLabel: RECOVERY_EVIDENCE_LABEL,
    classification: 'ZERO_COST_HOSTED_ORIGIN_RECOVERY_BUNDLE',
    source: {
      kind: options.sourceKind,
      projectRef: options.sourceProjectRef,
      environmentLabel: options.environmentLabel,
      reviewedRepositoryGitSha: reviewedGitSha,
    },
    capture: {
      startedAt,
      completedAt,
      supabaseCliVersion: supabaseCliVersion(options.repositoryRoot),
      nodeVersion: process.version,
    },
    postgres: evidence.postgres,
    migrations: {
      count: evidence.migrationVersions.length,
      latest: [...evidence.migrationVersions].sort().at(-1) as string,
      versions: [...evidence.migrationVersions].sort(),
    },
    database,
    auth: evidence.auth,
    storage: {
      buckets: summarizeBuckets(bucketConfigurations, objectRecords),
      privateObjectManifest: {
        path: BUNDLE_PATHS.privateObjectManifest,
        sha256: privateObjectManifestChecksum,
        objectCount: objectRecords.length,
      },
    },
    dataEvidence: {
      path: BUNDLE_PATHS.dataEvidence,
      sha256: sha256(serializedDataEvidence),
      tableCount: evidence.tables.length,
    },
    gate4Evidence: { path: BUNDLE_PATHS.gate4Evidence, sha256: gate4Checksum },
    managedSchemaCustomizations: {
      path: BUNDLE_PATHS.managedSchemaCustomizations,
      sha256: managedSchemaChecksum,
      authCount: managedCounts.auth,
      storageCount: managedCounts.storage,
    },
    executionControl: {
      budgetGuard: evidence.executionControl.budgetGuard,
      launchReservationCount: evidence.executionControl.launchReservationCount,
      executorRegistrationCount: evidence.executionControl.executorRegistrationCount,
      reservationChecksum: evidence.executionControl.reservationChecksum,
    },
  };

  const errors = validateRecoveryBundleManifest(manifest, {
    repositoryMigrationVersions: expectedMigrations,
  });
  if (errors.length > 0) {
    throw new RecoveryGuardError(`SOURCE_CAPTURE_INCOMPLETE:${errors[0]}`);
  }
  writeJsonArtifact(bundleDirectory, BUNDLE_PATHS.manifest, manifest);
  fs.rmSync(bundleFile(bundleDirectory, BUNDLE_PATHS.incompleteMarker), { force: true });

  return {
    bundleDirectory,
    manifest,
    objectCount: objectRecords.length,
    startedAt,
    completedAt,
  };
}

export const HOSTED_CAPTURE_APPROVED_REF = APPROVED_HOSTED_SOURCE_PROJECT_REF;
