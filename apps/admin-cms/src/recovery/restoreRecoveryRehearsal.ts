import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  compareAuthEvidence,
  compareBucketConfiguration,
  compareExecutionControlEvidence,
  compareStorageObjects,
  compareTableDataEvidence,
  summarizeBuckets,
  validateRecoveryBundleManifest,
  type BucketConfigurationEvidence,
  type StorageDifference,
  type TableDataDifference,
} from './recoveryBundle';
import {
  compareGate4Evidence,
  validateCurrentRepositoryGate4Contract,
  type Gate4ComparisonResult,
  type Gate4EvidenceStats,
} from '../deployment/gate4SchemaEvidence';
import { collectLocalGate4Evidence } from '../scripts/checkGate4SchemaEvidence';
import { repositoryMigrationVersions } from './captureRecoveryBackup';
import {
  BUNDLE_PATHS,
  assertRecoveryBundleDirectory,
  bundleFile,
  loadRecoveryBundle,
  readStorageObjectBlob,
  type LoadedRecoveryBundle,
} from './recoveryBundleStore';
import {
  copyFileIntoDisposableContainer,
  createDisposableNetwork,
  createDisposableStackIdentity,
  inspectDisposableResidue,
  prepareDisposableContainerStaging,
  readDisposableStackEnv,
  removeDisposableResidue,
  residueIsAbsent,
  runDisposablePsql,
  startDisposableStack,
  stopDisposableStack,
  SUPPORTED_RESTORE_POSTGRES_MAJORS,
  type DisposableStackIdentity,
} from './disposableSupabaseStack';
import {
  readRestoredObjects,
  restoreBucketConfigurations,
  restoreBucketObjects,
  type CapturedStorageObject,
} from './storageTransfer';
import { readRecoveryEvidence } from './supabaseRecoveryCli';
import {
  CANONICAL_STORAGE_BUCKETS,
  DATABASE_BACKUP_ARTIFACTS,
  RecoveryGuardError,
  resolveClassification,
  type RecoveryClassification,
} from './zeroCostRecoveryContract';

/**
 * Phase B: restore a bundle into a disposable local target and verify it.
 *
 * The target is created bare on purpose. It supplies only the managed service schemas a
 * self-hosted Supabase provides (auth, storage, graphql, vault); it carries no repository
 * migrations, no seed, and no canonical buckets, so every application object, row, role, and
 * Storage byte observed afterwards came from the backup rather than from configuration.
 */

export const DEFAULT_RESTORE_PORT_BASE = 54940;
export const DEFAULT_RESTORE_POSTGRES_MAJOR_VERSION = 17;
const MAX_CROSS_ENGINE_GATE4_DIFFERENCES = 1_000;

export interface RestoreVerificationOptions {
  repositoryRoot: string;
  bundleDirectory: string;
  portBase?: number;
  /** Skips the Next.js smoke when the caller only needs database and Storage evidence. */
  skipApplicationSmoke?: boolean;
  applicationPort?: number;
  /** Defaults to the PostgreSQL 17 hosted-engine lineage already validated for this rehearsal. */
  targetPostgresMajorVersion?: number;
}

export interface Gate4RestoredResult {
  selfCheckClassification: string;
  sourceComparisonClassification: string;
  expectedStats: Gate4EvidenceStats | null;
  actualStats: Gate4EvidenceStats | null;
  differences: string[];
  crossEnginePortabilityNormalization: boolean;
}

export interface ApplicationSmokeResult {
  attempted: boolean;
  healthStatus: number | null;
  readinessStatus: number | null;
  readinessClassification: string | null;
  loginStatus: number | null;
  markerPresent: boolean;
  stagingIdentityClaimed: boolean;
}

export interface RestoreVerificationResult {
  classification: RecoveryClassification;
  findings: string[];
  restoreStartedAt: string;
  restoreCompletedAt: string;
  verificationCompletedAt: string;
  backupAgeAtRestoreStartMs: number;
  restoreDurationMs: number;
  verificationDurationMs: number;
  sourcePostgresMajorVersion: number;
  restoredPostgresMajorVersion: number;
  migrationCount: number;
  latestMigration: string;
  publicApplicationTables: number;
  executionControlTables: number;
  storageObjectCount: number;
  databaseIntegrityMatch: boolean;
  storageIntegrityMatch: boolean;
  assistiveCostFenceMatch: boolean;
  sourceAuthUserCount: number;
  restoredAuthUserCount: number;
  authCountMatch: boolean;
  restoredAuthOrphanIdentityCount: number;
  bucketSummaries: string[];
  gate4: Gate4RestoredResult | null;
  applicationSmoke: ApplicationSmokeResult;
  residueAbsent: boolean;
}

function containerStagedPath(stagingDirectory: string, artifact: string): string {
  return `${stagingDirectory}/${artifact}`;
}

/**
 * Replays the official Supabase restore order in one transaction, so any unexpected SQL error
 * leaves the target untouched instead of half-restored.
 */
export function restoreDatabase(
  identity: DisposableStackIdentity,
  bundleDirectory: string,
): void {
  const stagingDirectory = prepareDisposableContainerStaging(identity);
  for (const artifact of DATABASE_BACKUP_ARTIFACTS) {
    copyFileIntoDisposableContainer(
      identity,
      bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/${artifact}`),
      containerStagedPath(stagingDirectory, artifact),
    );
  }
  try {
    runDisposablePsql(identity, {
      singleTransaction: true,
      files: [
        containerStagedPath(stagingDirectory, 'roles.sql'),
        containerStagedPath(stagingDirectory, 'schema.sql'),
        containerStagedPath(stagingDirectory, 'migrations-schema.sql'),
      ],
    });
    // Data is replayed with replication triggers disabled, exactly as the Supabase data dump
    // expects, then migration history is applied last.
    runDisposablePsql(identity, {
      singleTransaction: true,
      command: 'SET session_replication_role = replica',
      files: [
        containerStagedPath(stagingDirectory, 'data.sql'),
        containerStagedPath(stagingDirectory, 'migrations-data.sql'),
      ],
    });
  } catch {
    throw new RecoveryGuardError('RESTORE_SQL_FAILED');
  }
}

async function restoreStorage(
  client: SupabaseClient,
  bundle: LoadedRecoveryBundle,
): Promise<void> {
  const configurations: BucketConfigurationEvidence[] = bundle.manifest.storage.buckets.map((bucket) => ({
    id: bucket.id,
    name: bucket.name,
    public: bucket.public,
    fileSizeLimit: bucket.fileSizeLimit,
    allowedMimeTypes: bucket.allowedMimeTypes,
  }));
  await restoreBucketConfigurations(client, configurations);

  for (const record of bundle.privateObjects) {
    const object: CapturedStorageObject = {
      record,
      content: readStorageObjectBlob(bundle.directory, record.sha256),
    };
    await restoreBucketObjects(client, [object]);
  }
}

function runGate4(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
  sourceEvidence: unknown,
  sourceKind: LoadedRecoveryBundle['manifest']['source']['kind'],
  sourcePostgresMajorVersion: number,
  targetPostgresMajorVersion: number,
): Gate4RestoredResult {
  const restoredEvidence = collectLocalGate4Evidence(repositoryRoot, identity.projectId);
  const contractErrors = validateCurrentRepositoryGate4Contract(
    restoredEvidence,
    repositoryMigrationVersions(repositoryRoot),
  );
  const selfComparison = compareGate4Evidence(restoredEvidence, restoredEvidence);
  const sourceComparison = compareGate4Evidence(
    restoredEvidence,
    sourceEvidence,
    MAX_CROSS_ENGINE_GATE4_DIFFERENCES,
  );
  const sourceContractErrors = validateCurrentRepositoryGate4Contract(
    sourceEvidence,
    repositoryMigrationVersions(repositoryRoot),
  );
  const crossEnginePortabilityNormalization = crossEngineDifferencesAreExpected({
    comparison: sourceComparison,
    sourceContractErrors,
    sourceKind,
    sourcePostgresMajorVersion,
    targetPostgresMajorVersion,
  });
  return {
    selfCheckClassification: contractErrors.length > 0
      ? `EVIDENCE_INVALID:${contractErrors[0]}`
      : selfComparison.classification,
    sourceComparisonClassification: sourceComparison.validationErrors.length > 0
      ? `EVIDENCE_INVALID:${sourceComparison.validationErrors[0]}`
      : crossEnginePortabilityNormalization
        ? 'GATE4_MATCH_CROSS_ENGINE_PORTABLE'
        : sourceComparison.classification,
    expectedStats: sourceComparison.expectedStats ?? selfComparison.expectedStats ?? null,
    actualStats: sourceComparison.actualStats ?? null,
    differences: sourceComparison.differences.slice(0, 20).map((difference) => (
      `${difference.category}:${difference.kind}:${difference.key}`
      + (difference.changedFields?.length ? `:${difference.changedFields.join(',')}` : '')
    )),
    crossEnginePortabilityNormalization,
  };
}

const EXPECTED_PG15_TO_PG17_CONSTRAINT_RENDERING_KEYS = new Set([
  'public.participant_preview_notifications.check_participant_preview_notification_transport_reference',
  'public.public_feed_operations.public_feed_operations_public_id_check',
  'public.public_feed_version_members.public_feed_version_members_public_id_check',
  'public.public_feed_versions.public_feed_versions_affected_public_id_check',
  'public.staff_provisioning_requests.check_staff_provisioning_roles',
]);

function crossEngineDifferencesAreExpected(input: {
  comparison: Gate4ComparisonResult;
  sourceContractErrors: readonly string[];
  sourceKind: LoadedRecoveryBundle['manifest']['source']['kind'];
  sourcePostgresMajorVersion: number;
  targetPostgresMajorVersion: number;
}): boolean {
  if (input.sourceKind !== 'disposable-local-synthetic'
    || input.sourcePostgresMajorVersion !== 15
    || input.targetPostgresMajorVersion !== 17
    || input.sourceContractErrors.length > 0
    || input.comparison.classification !== 'GATE4_DRIFT'
    || input.comparison.validationErrors.length > 0
    || input.comparison.totalDifferences !== input.comparison.differences.length) {
    return false;
  }
  const mismatchedCategories = Object.entries(input.comparison.categoryMatches)
    .filter(([, matches]) => matches === false)
    .map(([category]) => category);
  if (mismatchedCategories.some((category) => !['CONSTRAINTS', 'TABLE_GRANTS'].includes(category))) {
    return false;
  }
  for (const difference of input.comparison.differences) {
    if (difference.category === 'CONSTRAINTS') {
      if (difference.kind !== 'CHANGED'
        || difference.changedFields?.join(',') !== 'definition'
        || !EXPECTED_PG15_TO_PG17_CONSTRAINT_RENDERING_KEYS.has(difference.key)) {
        return false;
      }
      continue;
    }
    if (difference.category === 'TABLE_GRANTS') {
      const privilege = difference.key.split('.').at(-1);
      if (difference.kind !== 'MISSING'
        || !['MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE'].includes(privilege ?? '')) {
        return false;
      }
      continue;
    }
    return false;
  }
  return mismatchedCategories.length > 0;
}

async function probe(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
}

/**
 * Boots the reviewed Admin/CMS against the restored target. No real staging credential is used and
 * no copied identity is signed in: the smoke only proves the restored database serves the
 * application surfaces and that readiness still refuses to claim staging identity.
 */
async function runApplicationSmoke(
  repositoryRoot: string,
  stackEnv: { apiUrl: string; serviceRoleKey: string; anonKey: string },
  port: number,
): Promise<ApplicationSmokeResult> {
  const result: ApplicationSmokeResult = {
    attempted: true,
    healthStatus: null,
    readinessStatus: null,
    readinessClassification: null,
    loginStatus: null,
    markerPresent: false,
    stagingIdentityClaimed: false,
  };
  const appDirectory = path.join(repositoryRoot, 'apps', 'admin-cms');
  const child: ChildProcess = spawn(process.execPath, [
    require.resolve('next/dist/bin/next', { paths: [appDirectory] }),
    'dev', '--hostname', '127.0.0.1', '--port', String(port),
  ], {
    cwd: appDirectory,
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'development',
      PATH: process.env.PATH,
      Path: process.env.Path,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      ComSpec: process.env.ComSpec,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      PORT: String(port),
      NEXT_PUBLIC_SUPABASE_URL: stackEnv.apiUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: stackEnv.anonKey,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stackEnv.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: stackEnv.serviceRoleKey,
      SUPABASE_SECRET_KEY: '',
      CAPSTONE_AUTH_FLOW_SECRET: 'zero-cost-recovery-rehearsal-synthetic-auth-flow-secret',
      SUPABASE_DRAFT_BUCKET: 'project-drafts-private',
      SUPABASE_PUBLIC_ASSETS_BUCKET: 'project-public-assets',
      SUPABASE_PUBLIC_FEEDS_BUCKET: 'public-feeds',
      SUPABASE_PUBLIC_FEED_FILE: 'capstones-latest.json',
      CAPSTONE_RUNTIME_ENV: '',
    },
  });

  try {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const health = await probe(`http://127.0.0.1:${port}/api/health`);
      if (health?.status === 200) {
        result.healthStatus = health.status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    const readiness = await probe(`http://127.0.0.1:${port}/api/readiness`);
    if (readiness) {
      result.readinessStatus = readiness.status;
      try {
        const body = await readiness.json() as { classification?: string };
        result.readinessClassification = body.classification ?? null;
        result.stagingIdentityClaimed = body.classification === 'READY';
      } catch {
        result.readinessClassification = null;
      }
    }

    const login = await probe(`http://127.0.0.1:${port}/login`);
    if (login) {
      result.loginStatus = login.status;
      const body = await login.text();
      result.markerPresent = body.includes('Capstone Impact');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  return result;
}

export function applicationSmokeMatchesRecoveryContract(result: ApplicationSmokeResult): boolean {
  return result.healthStatus === 200
    && result.loginStatus === 200
    && result.markerPresent
    && result.readinessStatus === 503
    && result.readinessClassification === 'CONFIGURATION_NOT_READY'
    && !result.stagingIdentityClaimed;
}

function describeStorageDifferences(differences: readonly StorageDifference[]): string[] {
  return differences
    .slice(0, 20)
    .map((difference) => `Storage ${difference.kind} in ${difference.bucket} (key digest ${difference.keyDigest.slice(0, 12)}).`);
}

function describeTableDifferences(differences: readonly TableDataDifference[]): string[] {
  return differences
    .slice(0, 20)
    .map((difference) => `Data ${difference.field} drift on ${difference.schema}.${difference.table}.`);
}

/** Restores the bundle into a fresh disposable target and verifies it end to end. */
export async function runRestoreVerification(
  options: RestoreVerificationOptions,
): Promise<RestoreVerificationResult> {
  const bundleDirectory = assertRecoveryBundleDirectory(options.bundleDirectory, options.repositoryRoot);
  const bundle = loadRecoveryBundle(bundleDirectory);
  const manifestErrors = validateRecoveryBundleManifest(bundle.manifest);
  if (manifestErrors.length > 0) {
    throw new RecoveryGuardError(`RECOVERY_BUNDLE_INVALID:${manifestErrors[0]}`);
  }
  const sourceGate4Errors = validateCurrentRepositoryGate4Contract(
    bundle.gate4Evidence,
    repositoryMigrationVersions(options.repositoryRoot),
  );
  if (sourceGate4Errors.length > 0) {
    throw new RecoveryGuardError(`RECOVERY_BUNDLE_GATE4_EVIDENCE_INVALID:${sourceGate4Errors[0]}`);
  }

  const sourcePostgresMajorVersion = bundle.manifest.postgres.majorVersion;
  if (!SUPPORTED_RESTORE_POSTGRES_MAJORS.includes(sourcePostgresMajorVersion as 15 | 17)) {
    throw new RecoveryGuardError(`SOURCE_POSTGRES_MAJOR_UNSUPPORTED:${sourcePostgresMajorVersion}`);
  }
  const targetPostgresMajorVersion = options.targetPostgresMajorVersion
    ?? DEFAULT_RESTORE_POSTGRES_MAJOR_VERSION;
  if (!SUPPORTED_RESTORE_POSTGRES_MAJORS.includes(targetPostgresMajorVersion as 15 | 17)) {
    throw new RecoveryGuardError(`RESTORE_POSTGRES_MAJOR_UNSUPPORTED:${targetPostgresMajorVersion}`);
  }

  const identity = createDisposableStackIdentity({
    repositoryRoot: options.repositoryRoot,
    mode: 'bare-restore-target',
    portBase: options.portBase ?? DEFAULT_RESTORE_PORT_BASE,
    postgresMajorVersion: targetPostgresMajorVersion,
    tag: 'target',
  });

  const findings: RecoveryClassification[] = [];
  const notes: string[] = [];
  let networkId = '';
  let started = false;
  let residueAbsent = false;
  let restoreStartedAt = new Date().toISOString();
  let restoreCompletedAt = restoreStartedAt;
  let verificationCompletedAt = restoreStartedAt;
  let gate4: Gate4RestoredResult | null = null;
  let applicationSmoke: ApplicationSmokeResult = {
    attempted: false,
    healthStatus: null,
    readinessStatus: null,
    readinessClassification: null,
    loginStatus: null,
    markerPresent: false,
    stagingIdentityClaimed: false,
  };
  let restoredEvidence: Awaited<ReturnType<typeof readRecoveryEvidence>> | null = null;
  let restoredObjectCount = 0;
  let bucketSummaries: string[] = [];
  let databaseIntegrityMatch = false;
  let storageIntegrityMatch = false;
  let assistiveCostFenceMatch = false;

  try {
    networkId = createDisposableNetwork(identity);
    restoreStartedAt = new Date().toISOString();
    started = true;
    startDisposableStack(options.repositoryRoot, identity, networkId);

    restoreDatabase(identity, bundle.directory);

    const stackEnv = readDisposableStackEnv(options.repositoryRoot, identity);
    const client = createClient(stackEnv.apiUrl, stackEnv.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(120_000) }) },
    });
    await restoreStorage(client, bundle);
    restoreCompletedAt = new Date().toISOString();

    restoredEvidence = readRecoveryEvidence(
      options.repositoryRoot,
      { kind: 'local', workdir: identity.workdir },
      path.join(identity.workdir, 'scratch'),
    );

    const restoredObjects = await readRestoredObjects(client, [...CANONICAL_STORAGE_BUCKETS]);
    restoredObjectCount = restoredObjects.length;
    const restoredBuckets = restoredEvidence.buckets;
    bucketSummaries = summarizeBuckets(restoredBuckets, restoredObjects)
      .map((bucket) => `${bucket.id}: ${bucket.objectCount} objects, ${bucket.totalBytes} bytes, root ${bucket.checksumRoot.slice(0, 12)}`);

    const storageDifferences = compareStorageObjects(bundle.privateObjects, restoredObjects);
    const bucketDifferences = compareBucketConfiguration(
      bundle.manifest.storage.buckets.map((bucket) => ({
        id: bucket.id,
        name: bucket.name,
        public: bucket.public,
        fileSizeLimit: bucket.fileSizeLimit,
        allowedMimeTypes: bucket.allowedMimeTypes,
      })),
      restoredBuckets,
    );
    if (storageDifferences.length > 0 || bucketDifferences.length > 0) {
      findings.push('STORAGE_RESTORE_DRIFT');
      notes.push(...describeStorageDifferences(storageDifferences));
      notes.push(...bucketDifferences.map(
        (difference) => `Bucket configuration drift on ${difference.bucket} field ${difference.field}.`,
      ));
    }
    storageIntegrityMatch = storageDifferences.length === 0 && bucketDifferences.length === 0;

    const tableDifferences = compareTableDataEvidence(bundle.dataEvidence, restoredEvidence.tables);
    const authDifferences = compareAuthEvidence(bundle.manifest.auth, restoredEvidence.auth);
    const controlDifferences = compareExecutionControlEvidence(
      bundle.manifest.executionControl,
      restoredEvidence.executionControl,
    );
    const restoredMigrations = [...restoredEvidence.migrationVersions].sort();
    const capturedMigrations = [...bundle.manifest.migrations.versions].sort();
    if (JSON.stringify(restoredMigrations) !== JSON.stringify(capturedMigrations)) {
      findings.push('RESTORE_INTEGRITY_DRIFT');
      notes.push('Restored migration history does not match the captured migration history.');
    }
    if (tableDifferences.length > 0 || authDifferences.length > 0 || controlDifferences.length > 0) {
      findings.push('RESTORE_INTEGRITY_DRIFT');
      notes.push(...describeTableDifferences(tableDifferences), ...authDifferences, ...controlDifferences);
    }
    if (!restoredEvidence.executionControl.schemaPresent) {
      findings.push('RESTORE_INTEGRITY_DRIFT');
      notes.push('Restored target has no assistive execution-control state; treat the cloud executor as unavailable.');
    }
    assistiveCostFenceMatch = restoredEvidence.executionControl.schemaPresent
      && controlDifferences.length === 0;
    databaseIntegrityMatch = JSON.stringify(restoredMigrations) === JSON.stringify(capturedMigrations)
      && tableDifferences.length === 0
      && authDifferences.length === 0
      && controlDifferences.length === 0
      && restoredEvidence.executionControl.schemaPresent;

    gate4 = runGate4(
      options.repositoryRoot,
      identity,
      bundle.gate4Evidence,
      bundle.manifest.source.kind,
      sourcePostgresMajorVersion,
      targetPostgresMajorVersion,
    );
    if (gate4.selfCheckClassification !== 'GATE4_MATCH'
      || !['GATE4_MATCH', 'GATE4_MATCH_CROSS_ENGINE_PORTABLE']
        .includes(gate4.sourceComparisonClassification)) {
      findings.push('GATE4_DRIFT');
      notes.push(
        `Gate 4 restored-target self-check: ${gate4.selfCheckClassification}.`,
        `Gate 4 restored-versus-source comparison: ${gate4.sourceComparisonClassification}.`,
        ...gate4.differences.map((difference) => `Gate 4 difference: ${difference}.`),
      );
    }

    if (!options.skipApplicationSmoke) {
      applicationSmoke = await runApplicationSmoke(
        options.repositoryRoot,
        stackEnv,
        options.applicationPort ?? 3_017,
      );
      const smokeOk = applicationSmokeMatchesRecoveryContract(applicationSmoke);
      if (!smokeOk) {
        findings.push('RESTORE_INTEGRITY_DRIFT');
        notes.push('Restored-target application smoke did not produce the expected local classification.');
      }
    }
    verificationCompletedAt = new Date().toISOString();
  } catch (error) {
    findings.push(error instanceof RecoveryGuardError && error.code.startsWith('RESTORE_SQL_FAILED')
      ? 'RESTORE_FAILED'
      : 'RESTORE_FAILED');
    notes.push(error instanceof Error ? error.message : 'RESTORE_FAILED');
  } finally {
    if (started) {
      try {
        stopDisposableStack(options.repositoryRoot, identity, networkId);
      } catch {
        notes.push('Disposable restore target did not stop cleanly; exact-identity cleanup continues.');
      }
    }
    try {
      removeDisposableResidue(identity);
    } catch {
      notes.push('Disposable restore target cleanup raised an error.');
    }
    try {
      residueAbsent = residueIsAbsent(inspectDisposableResidue(identity));
    } catch {
      residueAbsent = false;
    }
    if (!residueAbsent) {
      findings.push('CLEANUP_FAILED');
      notes.push('Verifier-owned Docker residue remains after cleanup.');
    }
  }

  const publicTables = restoredEvidence?.tables.filter((table) => table.schema === 'public').length ?? 0;
  const executionControlTables = restoredEvidence?.tables
    .filter((table) => table.schema === 'assistive_execution_control').length ?? 0;

  return {
    classification: resolveClassification(findings),
    findings: notes,
    restoreStartedAt,
    restoreCompletedAt,
    verificationCompletedAt,
    backupAgeAtRestoreStartMs: Math.max(
      0,
      Date.parse(restoreStartedAt) - Date.parse(bundle.manifest.capture.completedAt),
    ),
    restoreDurationMs: Math.max(0, Date.parse(restoreCompletedAt) - Date.parse(restoreStartedAt)),
    verificationDurationMs: Math.max(0, Date.parse(verificationCompletedAt) - Date.parse(restoreStartedAt)),
    sourcePostgresMajorVersion,
    restoredPostgresMajorVersion: restoredEvidence?.postgres.majorVersion ?? targetPostgresMajorVersion,
    migrationCount: restoredEvidence?.migrationVersions.length ?? 0,
    latestMigration: [...(restoredEvidence?.migrationVersions ?? [])].sort().at(-1) ?? 'UNAVAILABLE',
    publicApplicationTables: publicTables,
    executionControlTables,
    storageObjectCount: restoredObjectCount,
    databaseIntegrityMatch,
    storageIntegrityMatch,
    assistiveCostFenceMatch,
    sourceAuthUserCount: bundle.manifest.auth.userCount,
    restoredAuthUserCount: restoredEvidence?.auth.userCount ?? 0,
    authCountMatch: restoredEvidence !== null
      && bundle.manifest.auth.userCount === restoredEvidence.auth.userCount,
    restoredAuthOrphanIdentityCount: restoredEvidence?.auth.orphanIdentityCount ?? -1,
    bucketSummaries,
    gate4,
    applicationSmoke,
    residueAbsent,
  };
}

/** The bundle is preserved on every outcome; only the operator may delete recovery evidence. */
export function assertBundlePreserved(bundleDirectory: string): boolean {
  return fs.existsSync(bundleFile(bundleDirectory, BUNDLE_PATHS.manifest));
}
