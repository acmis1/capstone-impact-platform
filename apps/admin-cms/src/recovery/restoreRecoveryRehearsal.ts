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
import {
  readManagedSchemaCustomizationEvidence,
  readRecoveryEvidence,
} from './supabaseRecoveryCli';
import {
  buildApprovedManagedSchemaCustomizationRestoreSql,
  compareManagedSchemaCustomizations,
  EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT,
  EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT,
  managedSchemaCustomizationCounts,
  REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
  type ManagedSchemaCustomizationEvidence,
} from './managedSchemaCustomizations';
import {
  CANONICAL_STORAGE_BUCKETS,
  DATABASE_BACKUP_ARTIFACTS,
  RecoveryGuardError,
  resolveClassification,
  type RecoveryClassification,
} from './zeroCostRecoveryContract';
import {
  ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL,
  REMOVE_CUSTOM_CLAIMS_ALLOWLIST_FOR_SYNTHETIC_TARGET_SQL,
  buildManagedAuthCatalogEvidenceSql,
  deriveManagedAuthCopyRequirements,
  parseManagedAuthCatalogEvidence,
  planManagedAuthSchemaCompatibility,
  type ManagedAuthCompatibilityPlan,
  type ManagedAuthCopyRequirement,
} from './managedAuthSchemaCompatibility';

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
  /** Synthetic-only regression proof that the unaligned data replay still fails transactionally. */
  proveUnalignedManagedAuthReplayFailure?: boolean;
  /** Synthetic-only deterministic emulation of the pinned target before Auth migration 20260625. */
  simulatePreCustomClaimsAllowlistTarget?: boolean;
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
  managedAuthCustomizationCount: number;
  expectedManagedAuthCustomizationCount: number;
  managedStorageCustomizationCount: number;
  expectedManagedStorageCustomizationCount: number;
  managedSchemaCustomizationsMatch: boolean;
  managedAuthCompatibility: 'NOT_RUN' | 'MATCH' | 'ALIGNED_KNOWN_DELTA';
  legacyUnalignedDataReplayFailed: boolean | null;
  managedAuthBehaviorVerified: boolean | null;
  bucketSummaries: string[];
  gate4: Gate4RestoredResult | null;
  applicationSmoke: ApplicationSmokeResult;
  residueAbsent: boolean;
}

function containerStagedPath(stagingDirectory: string, artifact: string): string {
  return `${stagingDirectory}/${artifact}`;
}

/**
 * Replays the official Supabase restore order in two fail-fast transactional phases: schema first,
 * then data. A data-phase failure can leave the schema phase committed in this verifier-owned
 * disposable target; it can never produce VERIFIED, and mandatory exact-identity cleanup removes
 * the partial target.
 */
function stageDatabaseArtifacts(
  identity: DisposableStackIdentity,
  bundleDirectory: string,
): string {
  const stagingDirectory = prepareDisposableContainerStaging(identity);
  for (const artifact of DATABASE_BACKUP_ARTIFACTS) {
    copyFileIntoDisposableContainer(
      identity,
      bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/${artifact}`),
      containerStagedPath(stagingDirectory, artifact),
    );
  }
  return stagingDirectory;
}

/** Schema replay is separately classified so it cannot be confused with provider data drift. */
export function restoreDatabaseSchema(
  identity: DisposableStackIdentity,
  stagingDirectory: string,
): void {
  try {
    runDisposablePsql(identity, {
      singleTransaction: true,
      files: [
        containerStagedPath(stagingDirectory, 'roles.sql'),
        containerStagedPath(stagingDirectory, 'schema.sql'),
        containerStagedPath(stagingDirectory, 'migrations-schema.sql'),
      ],
    });
  } catch {
    throw new RecoveryGuardError('RESTORE_SCHEMA_SQL_FAILED');
  }
}

/** Data replay follows compatibility alignment and retains its own safe failure code. */
export function restoreDatabaseData(
  identity: DisposableStackIdentity,
  stagingDirectory: string,
): void {
  try {
    runDisposablePsql(identity, {
      singleTransaction: true,
      command: 'SET session_replication_role = replica',
      files: [
        containerStagedPath(stagingDirectory, 'data.sql'),
        containerStagedPath(stagingDirectory, 'migrations-data.sql'),
      ],
    });
  } catch {
    throw new RecoveryGuardError('RESTORE_DATA_SQL_FAILED');
  }
}

function readManagedAuthCatalog(identity: DisposableStackIdentity) {
  try {
    return parseManagedAuthCatalogEvidence(runDisposablePsql(identity, {
      command: buildManagedAuthCatalogEvidenceSql(),
      timeoutMs: 120_000,
    }));
  } catch (error) {
    if (error instanceof RecoveryGuardError) throw error;
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_CATALOG_QUERY_FAILED');
  }
}

function inspectManagedAuthCompatibility(
  identity: DisposableStackIdentity,
  dataSqlFile: string,
): { requirements: ManagedAuthCopyRequirement[]; plan: ManagedAuthCompatibilityPlan } {
  let requirements: ManagedAuthCopyRequirement[];
  try {
    requirements = deriveManagedAuthCopyRequirements(fs.readFileSync(dataSqlFile, 'utf8'));
  } catch (error) {
    if (error instanceof RecoveryGuardError) throw error;
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_SOURCE_READ_FAILED');
  }
  return {
    requirements,
    plan: planManagedAuthSchemaCompatibility(requirements, readManagedAuthCatalog(identity)),
  };
}

function alignManagedAuthCompatibility(
  identity: DisposableStackIdentity,
  inspection: ReturnType<typeof inspectManagedAuthCompatibility>,
): 'MATCH' | 'ALIGNED_KNOWN_DELTA' {
  if (inspection.plan.action === 'MATCH') return 'MATCH';
  try {
    runDisposablePsql(identity, {
      singleTransaction: true,
      command: ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL,
      timeoutMs: 120_000,
      databaseUser: 'supabase_auth_admin',
    });
  } catch {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_ALIGNMENT_SQL_FAILED');
  }
  const recheck = planManagedAuthSchemaCompatibility(
    inspection.requirements,
    readManagedAuthCatalog(identity),
  );
  if (recheck.action !== 'MATCH') {
    throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_RECHECK_FAILED');
  }
  return 'ALIGNED_KNOWN_DELTA';
}

export function classifyRestoreFailure(error: unknown): RecoveryClassification {
  const code = error instanceof RecoveryGuardError ? error.code : '';
  if (code.startsWith('RESTORE_SCHEMA_SQL_FAILED')) return 'RESTORE_SCHEMA_FAILED';
  if (code.startsWith('RESTORE_DATA_SQL_FAILED')) return 'RESTORE_DATA_FAILED';
  if (code.startsWith('MANAGED_AUTH_COMPATIBILITY_')) {
    return 'MANAGED_AUTH_COMPATIBILITY_FAILED';
  }
  return 'RESTORE_FAILED';
}

/** Installs only fixed reviewed PP1 DDL after validating the checksum-bound source evidence. */
export function restoreManagedSchemaCustomizations(
  identity: DisposableStackIdentity,
  capturedEvidence: ManagedSchemaCustomizationEvidence,
): void {
  try {
    runDisposablePsql(identity, {
      singleTransaction: true,
      command: buildApprovedManagedSchemaCustomizationRestoreSql(capturedEvidence),
    });
  } catch {
    throw new RecoveryGuardError('MANAGED_SCHEMA_CUSTOMIZATION_RESTORE_FAILED');
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

/**
 * Bounded disposable-only behavior probe for both restored Auth trigger events. No identifier or
 * token is logged, and the entire target is removed by the verifier immediately afterwards.
 */
async function verifySyntheticManagedAuthTriggerBehavior(
  client: SupabaseClient,
): Promise<{ passed: boolean; stage: string }> {
  const { data: actor, error: actorError } = await client
    .from('user_roles')
    .select('user_id')
    .eq('role', 'admin')
    .limit(1)
    .maybeSingle();
  if (actorError || !actor?.user_id) return { passed: false, stage: 'ACTOR_UNAVAILABLE' };

  const email = 'managed-trigger-recovery@synthetic.invalid';
  const { data: reservationRaw, error: reservationError } = await client.rpc(
    'reserve_staff_provisioning',
    {
      p_actor_admin_id: actor.user_id,
      p_email: email,
      p_full_name: 'Synthetic Managed Trigger Probe',
      p_roles: ['reviewer'],
    },
  );
  if (reservationError || !reservationRaw || typeof reservationRaw !== 'object') {
    return { passed: false, stage: 'RESERVATION_CALL_FAILED' };
  }
  const reservation = reservationRaw as Record<string, unknown>;
  if (reservation.resultCode !== 'RESERVED'
    || typeof reservation.requestId !== 'string'
    || typeof reservation.authOwnershipToken !== 'string') {
    return { passed: false, stage: 'RESERVATION_NOT_CREATED' };
  }
  const transientMetadata = {
    staff_provisioning_request_id: reservation.requestId,
    staff_provisioning_ownership_token: reservation.authOwnershipToken,
    scope: 'synthetic-managed-trigger-probe',
  };
  const { data: created, error: createError } = await client.auth.admin.createUser({
    email,
    password: 'synthetic-managed-trigger-probe-password-2026',
    email_confirm: true,
    user_metadata: transientMetadata,
  });
  if (createError || !created.user) return { passed: false, stage: 'AUTH_INSERT_FAILED' };
  const { data: storedAfterInsert, error: readAfterInsertError } =
    await client.auth.admin.getUserById(created.user.id);
  if (readAfterInsertError || !storedAfterInsert.user) {
    return { passed: false, stage: 'AUTH_INSERT_READBACK_FAILED' };
  }
  const insertUserMetadata = storedAfterInsert.user.user_metadata ?? {};
  const insertAppMetadata = storedAfterInsert.user.app_metadata ?? {};
  const insertPassed = !('staff_provisioning_request_id' in insertUserMetadata)
    && !('staff_provisioning_ownership_token' in insertUserMetadata)
    && insertUserMetadata.scope === 'synthetic-managed-trigger-probe'
    && typeof insertAppMetadata.staff_provisioning_marker === 'string'
    && /^[0-9a-f]{64}$/.test(insertAppMetadata.staff_provisioning_marker);
  if (!insertPassed) return { passed: false, stage: 'AUTH_INSERT_SEMANTICS_MISMATCH' };

  const { data: updated, error: updateError } = await client.auth.admin.updateUserById(
    created.user.id,
    { user_metadata: { ...transientMetadata, scope: 'synthetic-managed-trigger-update-probe' } },
  );
  if (updateError || !updated.user) return { passed: false, stage: 'AUTH_UPDATE_FAILED' };
  const { data: storedAfterUpdate, error: readAfterUpdateError } =
    await client.auth.admin.getUserById(created.user.id);
  if (readAfterUpdateError || !storedAfterUpdate.user) {
    return { passed: false, stage: 'AUTH_UPDATE_READBACK_FAILED' };
  }
  const updateUserMetadata = storedAfterUpdate.user.user_metadata ?? {};
  const updateAppMetadata = storedAfterUpdate.user.app_metadata ?? {};
  const passed = !('staff_provisioning_request_id' in updateUserMetadata)
    && !('staff_provisioning_ownership_token' in updateUserMetadata)
    && updateUserMetadata.scope === 'synthetic-managed-trigger-update-probe'
    && updateAppMetadata.staff_provisioning_marker === insertAppMetadata.staff_provisioning_marker;
  return { passed, stage: passed ? 'MATCH' : 'AUTH_UPDATE_SEMANTICS_MISMATCH' };
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
  let restoredManagedSchemaEvidence: ManagedSchemaCustomizationEvidence | null = null;
  let restoredObjectCount = 0;
  let bucketSummaries: string[] = [];
  let databaseIntegrityMatch = false;
  let storageIntegrityMatch = false;
  let assistiveCostFenceMatch = false;
  let managedSchemaCustomizationsMatch = false;
  let managedAuthCompatibility: RestoreVerificationResult['managedAuthCompatibility'] = 'NOT_RUN';
  let legacyUnalignedDataReplayFailed: boolean | null = null;
  let managedAuthBehaviorVerified: boolean | null = null;

  try {
    networkId = createDisposableNetwork(identity);
    restoreStartedAt = new Date().toISOString();
    started = true;
    startDisposableStack(options.repositoryRoot, identity, networkId);

    if (options.simulatePreCustomClaimsAllowlistTarget) {
      if (bundle.manifest.source.kind !== 'disposable-local-synthetic'
        || !options.proveUnalignedManagedAuthReplayFailure) {
        throw new RecoveryGuardError(
          'MANAGED_AUTH_COMPATIBILITY_SYNTHETIC_BASELINE_PRECONDITION_FAILED',
        );
      }
      try {
        runDisposablePsql(identity, {
          singleTransaction: true,
          command: REMOVE_CUSTOM_CLAIMS_ALLOWLIST_FOR_SYNTHETIC_TARGET_SQL,
          timeoutMs: 120_000,
          databaseUser: 'supabase_auth_admin',
        });
      } catch {
        throw new RecoveryGuardError(
          'MANAGED_AUTH_COMPATIBILITY_SYNTHETIC_BASELINE_SETUP_FAILED',
        );
      }
    }

    const stagingDirectory = stageDatabaseArtifacts(identity, bundle.directory);
    restoreDatabaseSchema(identity, stagingDirectory);
    const compatibilityInspection = inspectManagedAuthCompatibility(
      identity,
      bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/data.sql`),
    );
    if (options.proveUnalignedManagedAuthReplayFailure) {
      if (bundle.manifest.source.kind !== 'disposable-local-synthetic'
        || compatibilityInspection.plan.action !== 'ADD_CUSTOM_CLAIMS_ALLOWLIST') {
        throw new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_LEGACY_PROBE_PRECONDITION_FAILED');
      }
      try {
        restoreDatabaseData(identity, stagingDirectory);
        legacyUnalignedDataReplayFailed = false;
      } catch (error) {
        if (!(error instanceof RecoveryGuardError) || error.code !== 'RESTORE_DATA_SQL_FAILED') {
          throw error;
        }
        legacyUnalignedDataReplayFailed = true;
      }
      if (!legacyUnalignedDataReplayFailed) {
        throw new RecoveryGuardError(
          'MANAGED_AUTH_COMPATIBILITY_LEGACY_PROBE_UNEXPECTEDLY_SUCCEEDED',
        );
      }
    }
    managedAuthCompatibility = alignManagedAuthCompatibility(identity, compatibilityInspection);
    restoreDatabaseData(identity, stagingDirectory);
    restoreManagedSchemaCustomizations(identity, bundle.managedSchemaCustomizations);

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
    restoredManagedSchemaEvidence = readManagedSchemaCustomizationEvidence(
      options.repositoryRoot,
      { kind: 'local', workdir: identity.workdir },
      path.join(identity.workdir, 'scratch'),
    );
    const managedSourceDifferences = compareManagedSchemaCustomizations(
      bundle.managedSchemaCustomizations,
      restoredManagedSchemaEvidence,
    );
    const managedRepositoryDifferences = compareManagedSchemaCustomizations(
      REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
      restoredManagedSchemaEvidence,
    );
    managedSchemaCustomizationsMatch = managedSourceDifferences.length === 0
      && managedRepositoryDifferences.length === 0;
    if (!managedSchemaCustomizationsMatch) {
      findings.push('MANAGED_SCHEMA_CUSTOMIZATION_DRIFT');
      notes.push(
        ...managedSourceDifferences.map((difference) => (
          `Managed-schema source comparison ${difference.kind}: ${difference.identity}.`
        )),
        ...managedRepositoryDifferences.map((difference) => (
          `Managed-schema repository comparison ${difference.kind}: ${difference.identity}.`
        )),
      );
    }

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
      && restoredEvidence.executionControl.schemaPresent
      && managedSchemaCustomizationsMatch;

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

    if (bundle.manifest.source.kind === 'disposable-local-synthetic') {
      const behavior = await verifySyntheticManagedAuthTriggerBehavior(client);
      managedAuthBehaviorVerified = behavior.passed;
      if (!managedAuthBehaviorVerified) {
        findings.push('MANAGED_SCHEMA_CUSTOMIZATION_DRIFT');
        notes.push(`Restored managed Auth INSERT/UPDATE trigger behavior probe failed at ${behavior.stage}.`);
      }
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
    findings.push(classifyRestoreFailure(error));
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
  const managedCounts = managedSchemaCustomizationCounts(restoredManagedSchemaEvidence);

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
    managedAuthCustomizationCount: managedCounts.auth,
    expectedManagedAuthCustomizationCount: EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT,
    managedStorageCustomizationCount: managedCounts.storage,
    expectedManagedStorageCustomizationCount: EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT,
    managedSchemaCustomizationsMatch,
    managedAuthCompatibility,
    legacyUnalignedDataReplayFailed,
    managedAuthBehaviorVerified,
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
