import { createHash } from 'node:crypto';
import {
  APPROVED_HOSTED_SOURCE_PROJECT_REF,
  CANONICAL_STORAGE_BUCKETS,
  DATABASE_BACKUP_ARTIFACTS,
  EXPECTED_LAUNCH_BUDGET_GUARD,
  RECOVERY_BUNDLE_FORMAT,
  RECOVERY_EVIDENCE_LABEL,
  type DatabaseBackupArtifact,
} from './zeroCostRecoveryContract';
import {
  EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT,
  EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT,
} from './managedSchemaCustomizations';

/**
 * Recovery bundle shape, validation, and source-versus-restored comparison.
 *
 * Everything here is pure so the negative cases in the test suite can prove that an incomplete or
 * tampered bundle can never be classified as verified.
 */

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface DatabaseArtifactEvidence {
  artifact: DatabaseBackupArtifact;
  bytes: number;
  sha256: string;
}

export interface BucketConfigurationEvidence {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
}

export interface BucketBackupEvidence extends BucketConfigurationEvidence {
  objectCount: number;
  totalBytes: number;
  /** Deterministic root over hashed keys and object checksums; never the keys themselves. */
  checksumRoot: string;
}

/** One captured object. This record lives only in the private manifest inside the bundle. */
export interface StorageObjectRecord {
  bucket: string;
  key: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
  lastModified: string | null;
  version: string | null;
}

export interface TableDataEvidence {
  schema: string;
  table: string;
  rowCount: number;
  /** Order-independent digest over per-row hashes; never row content. */
  checksum: string;
}

export interface ExecutionControlEvidence {
  budgetGuard: {
    environment: string;
    launchLimit: number;
    windowDays: number;
    maxActiveExecutions: number;
  } | null;
  launchReservationCount: number;
  executorRegistrationCount: number;
  /** Digest over reservation rows, so reset or truncated history cannot pass unnoticed. */
  reservationChecksum: string;
}

export interface AuthRecoveryEvidence {
  userCount: number;
  identityCount: number;
  orphanIdentityCount: number;
}

export type RecoverySourceKind = 'hosted-staging' | 'disposable-local-synthetic';

export interface RecoveryBundleManifest {
  formatVersion: typeof RECOVERY_BUNDLE_FORMAT;
  evidenceLabel: typeof RECOVERY_EVIDENCE_LABEL;
  source: {
    kind: RecoverySourceKind;
    projectRef: string;
    environmentLabel: string;
    reviewedRepositoryGitSha: string;
  };
  capture: {
    startedAt: string;
    completedAt: string;
    supabaseCliVersion: string;
    nodeVersion: string;
  };
  postgres: {
    majorVersion: number;
    reportedVersion: string;
  };
  migrations: {
    count: number;
    latest: string;
    versions: string[];
  };
  database: DatabaseArtifactEvidence[];
  auth: AuthRecoveryEvidence;
  storage: {
    buckets: BucketBackupEvidence[];
    privateObjectManifest: {
      path: string;
      sha256: string;
      objectCount: number;
    };
  };
  dataEvidence: {
    path: string;
    sha256: string;
    tableCount: number;
  };
  gate4Evidence: {
    path: string;
    sha256: string;
  };
  managedSchemaCustomizations: {
    path: string;
    sha256: string;
    authCount: number;
    storageCount: number;
  };
  executionControl: ExecutionControlEvidence;
  classification: 'ZERO_COST_HOSTED_ORIGIN_RECOVERY_BUNDLE';
}

/**
 * Deterministic per-bucket root. Keys are hashed rather than listed so the manifest carries proof
 * of the exact object set without carrying the object names.
 */
export function bucketChecksumRoot(
  objects: readonly Pick<StorageObjectRecord, 'key' | 'sha256'>[],
): string {
  const lines = objects
    .map((object) => `${sha256(object.key)}:${object.sha256}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256(lines.join('\n'));
}

export function summarizeBuckets(
  configurations: readonly BucketConfigurationEvidence[],
  objects: readonly StorageObjectRecord[],
): BucketBackupEvidence[] {
  return [...configurations]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((configuration) => {
      const owned = objects.filter((object) => object.bucket === configuration.id);
      return {
        ...configuration,
        allowedMimeTypes: configuration.allowedMimeTypes === null
          ? null
          : [...configuration.allowedMimeTypes].sort(),
        objectCount: owned.length,
        totalBytes: owned.reduce((total, object) => total + object.bytes, 0),
        checksumRoot: bucketChecksumRoot(owned),
      };
    });
}

const SENSITIVE_MANIFEST_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['a UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['a URL', /\bhttps?:\/\//i],
  ['a database connection string', /\bpostgres(?:ql)?:\/\//i],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{8,}/],
  ['a Supabase secret key', /\bsb_secret_/],
  ['a Supabase service-role key literal', /\bSERVICE_ROLE_KEY\b/],
];

/**
 * The safe manifest is the only recovery artifact intended for review and reporting, so it is
 * scanned for identity and credential shapes rather than trusted to have been built carefully.
 */
export function findSensitiveManifestContent(manifest: unknown): string[] {
  const serialized = JSON.stringify(manifest ?? null);
  return SENSITIVE_MANIFEST_PATTERNS
    .filter(([, pattern]) => pattern.test(serialized))
    .map(([label]) => `Backup manifest contains ${label}.`);
}

export interface ManifestValidationOptions {
  /** Migration versions the reviewed repository declares, used to detect capture drift. */
  repositoryMigrationVersions?: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDatabaseArtifacts(manifest: RecoveryBundleManifest, errors: string[]): void {
  const artifacts = Array.isArray(manifest.database) ? manifest.database : [];
  if (artifacts.length !== DATABASE_BACKUP_ARTIFACTS.length) {
    errors.push('Recovery bundle does not declare exactly the required database artifacts.');
  }
  for (const required of DATABASE_BACKUP_ARTIFACTS) {
    const matches = artifacts.filter((artifact) => artifact?.artifact === required);
    const found = matches[0];
    if (!found) {
      errors.push(`Recovery bundle is missing the ${required} database artifact.`);
      continue;
    }
    if (matches.length !== 1) {
      errors.push(`Recovery bundle declares ${required} more than once.`);
    }
    if (!Number.isSafeInteger(found.bytes) || found.bytes <= 0) {
      errors.push(`Database artifact ${required} records no captured bytes.`);
    }
    if (typeof found.sha256 !== 'string' || !SHA256_PATTERN.test(found.sha256)) {
      errors.push(`Database artifact ${required} has no valid SHA-256 checksum.`);
    }
  }
  const unexpected = artifacts
    .map((artifact) => artifact?.artifact)
    .filter((name) => !DATABASE_BACKUP_ARTIFACTS.includes(name as DatabaseBackupArtifact));
  for (const name of unexpected) {
    errors.push(`Recovery bundle declares an unexpected database artifact: ${String(name)}.`);
  }
}

function validateStorage(manifest: RecoveryBundleManifest, errors: string[]): void {
  const buckets = Array.isArray(manifest.storage?.buckets) ? manifest.storage.buckets : [];
  const observed = buckets.map((bucket) => bucket?.id).sort();
  const expected = [...CANONICAL_STORAGE_BUCKETS].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    errors.push(`Recovery bundle does not cover exactly the ${CANONICAL_STORAGE_BUCKETS.length} canonical release/recovery Storage buckets.`);
  }
  for (const bucket of buckets) {
    if (!bucket) continue;
    if (bucket.name !== bucket.id) {
      errors.push(`Bucket ${bucket.id} does not preserve its canonical identity/name.`);
    }
    if (typeof bucket.public !== 'boolean') {
      errors.push(`Bucket ${bucket.id} records no privacy state.`);
    }
    if (typeof bucket.checksumRoot !== 'string' || !SHA256_PATTERN.test(bucket.checksumRoot)) {
      errors.push(`Bucket ${bucket.id} has no valid aggregate checksum root.`);
    }
    if (!Number.isSafeInteger(bucket.objectCount) || bucket.objectCount < 0) {
      errors.push(`Bucket ${bucket.id} records no object count.`);
    }
    if (!Number.isSafeInteger(bucket.totalBytes) || bucket.totalBytes < 0) {
      errors.push(`Bucket ${bucket.id} records no byte total.`);
    }
    if (bucket.fileSizeLimit !== null
      && (!Number.isSafeInteger(bucket.fileSizeLimit) || bucket.fileSizeLimit <= 0)) {
      errors.push(`Bucket ${bucket.id} records an invalid file-size limit.`);
    }
    if (bucket.allowedMimeTypes !== null
      && (!Array.isArray(bucket.allowedMimeTypes)
        || bucket.allowedMimeTypes.some((type) => typeof type !== 'string' || type.length === 0))) {
      errors.push(`Bucket ${bucket.id} records invalid allowed MIME types.`);
    }
  }
  const reference = manifest.storage?.privateObjectManifest;
  if (!reference
    || reference.path !== 'storage/private-object-manifest.json'
    || !SHA256_PATTERN.test(reference.sha256 ?? '')
    || !Number.isSafeInteger(reference.objectCount)
    || reference.objectCount < 0) {
    errors.push('Recovery bundle does not reference a checksummed private object manifest.');
  }
}

function validateMigrations(
  manifest: RecoveryBundleManifest,
  options: ManifestValidationOptions,
  errors: string[],
): void {
  const migrations = manifest.migrations;
  const versions = Array.isArray(migrations?.versions) ? migrations.versions : null;
  if (!versions || versions.length === 0) {
    errors.push('Recovery bundle records no migration-history evidence.');
    return;
  }
  if (migrations.count !== versions.length) {
    errors.push('Recovery bundle migration count does not match the recorded migration versions.');
  }
  if (versions.some((version) => !/^\d{14}$/.test(version))) {
    errors.push('Recovery bundle contains an invalid migration version.');
  }
  if (new Set(versions).size !== versions.length) {
    errors.push('Recovery bundle contains duplicate migration versions.');
  }
  const latest = [...versions].sort().at(-1);
  if (migrations.latest !== latest) {
    errors.push('Recovery bundle latest migration does not match the recorded migration versions.');
  }
  const expected = options.repositoryMigrationVersions;
  if (expected) {
    if (versions.length !== expected.length) {
      errors.push(
        `Recovery bundle records ${versions.length} migrations; the reviewed repository declares ${expected.length}.`,
      );
    }
    if (JSON.stringify([...versions].sort()) !== JSON.stringify([...expected].sort())) {
      errors.push('Recovery bundle migration history does not match the reviewed repository manifest.');
    }
  }
}

function validateExecutionControl(manifest: RecoveryBundleManifest, errors: string[]): void {
  const control = manifest.executionControl;
  if (!isPlainObject(control)) {
    errors.push('Recovery bundle records no assistive execution-control evidence.');
    return;
  }
  const guard = control.budgetGuard as ExecutionControlEvidence['budgetGuard'];
  if (!guard) {
    errors.push('Recovery bundle records no assistive launch budget guard row.');
  } else if (
    guard.environment !== EXPECTED_LAUNCH_BUDGET_GUARD.environment
    || guard.launchLimit !== EXPECTED_LAUNCH_BUDGET_GUARD.launchLimit
    || guard.windowDays !== EXPECTED_LAUNCH_BUDGET_GUARD.windowDays
    || guard.maxActiveExecutions !== EXPECTED_LAUNCH_BUDGET_GUARD.maxActiveExecutions
  ) {
    errors.push('Assistive launch budget guard does not match the authoritative cost fence.');
  }
  if (!Number.isSafeInteger(control.launchReservationCount as number)
    || (control.launchReservationCount as number) < 0) {
    errors.push('Recovery bundle records no assistive launch reservation count.');
  }
  if (!Number.isSafeInteger(control.executorRegistrationCount as number)
    || (control.executorRegistrationCount as number) < 0) {
    errors.push('Recovery bundle records no assistive executor registration count.');
  }
  if (typeof control.reservationChecksum !== 'string'
    || !SHA256_PATTERN.test(control.reservationChecksum)) {
    errors.push('Recovery bundle records no assistive launch reservation checksum.');
  }
}

function validateManagedSchemaCustomizations(
  manifest: RecoveryBundleManifest,
  errors: string[],
): void {
  const managed = manifest.managedSchemaCustomizations;
  if (!isPlainObject(managed)
    || managed.path !== 'evidence/managed-schema-customizations.json'
    || typeof managed.sha256 !== 'string'
    || !SHA256_PATTERN.test(managed.sha256)
    || managed.authCount !== EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT
    || managed.storageCount !== EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT) {
    errors.push(
      'Recovery bundle references no complete checksummed managed-schema customization evidence.',
    );
  }
}

/** Structural gate. An invalid bundle can never proceed to a restore. */
export function validateRecoveryBundleManifest(
  input: unknown,
  options: ManifestValidationOptions = {},
): string[] {
  if (!isPlainObject(input)) return ['Recovery bundle manifest is not an object.'];
  const manifest = input as unknown as RecoveryBundleManifest;
  const errors: string[] = [];

  if (manifest.formatVersion !== RECOVERY_BUNDLE_FORMAT) {
    errors.push('Recovery bundle manifest declares an unsupported format version.');
  }
  if (manifest.evidenceLabel !== RECOVERY_EVIDENCE_LABEL) {
    errors.push('Recovery bundle manifest declares an unsupported evidence label.');
  }
  if (manifest.classification !== 'ZERO_COST_HOSTED_ORIGIN_RECOVERY_BUNDLE') {
    errors.push('Recovery bundle manifest declares an unsupported classification.');
  }
  if (!isPlainObject(manifest.source) || !/^[0-9a-f]{40}$/.test(manifest.source.reviewedRepositoryGitSha ?? '')) {
    errors.push('Recovery bundle manifest records no reviewed repository SHA.');
  } else {
    if (!['hosted-staging', 'disposable-local-synthetic'].includes(manifest.source.kind)) {
      errors.push('Recovery bundle manifest records an unsupported source kind.');
    }
    if (manifest.source.kind === 'hosted-staging'
      && manifest.source.projectRef !== APPROVED_HOSTED_SOURCE_PROJECT_REF) {
      errors.push('Hosted recovery bundle does not identify the approved staging project ref.');
    }
    if (typeof manifest.source.projectRef !== 'string'
      || !/^[a-z0-9-]{8,80}$/.test(manifest.source.projectRef)) {
      errors.push('Recovery bundle manifest records an invalid source project ref.');
    }
    if (typeof manifest.source.environmentLabel !== 'string'
      || !/^[a-z0-9-]{3,64}$/.test(manifest.source.environmentLabel)) {
      errors.push('Recovery bundle manifest records an invalid source environment label.');
    }
  }
  if (!isPlainObject(manifest.capture)
    || Number.isNaN(Date.parse(manifest.capture.startedAt ?? ''))
    || Number.isNaN(Date.parse(manifest.capture.completedAt ?? ''))) {
    errors.push('Recovery bundle manifest records no complete capture window.');
  } else if (Date.parse(manifest.capture.completedAt) < Date.parse(manifest.capture.startedAt)) {
    errors.push('Recovery bundle capture completion precedes its start.');
  }
  if (!isPlainObject(manifest.postgres)
    || ![15, 17].includes(manifest.postgres.majorVersion)
    || typeof manifest.postgres.reportedVersion !== 'string'
    || manifest.postgres.reportedVersion.length === 0) {
    errors.push('Recovery bundle manifest records no source PostgreSQL major version.');
  }
  if (!isPlainObject(manifest.auth)
    || !Number.isSafeInteger(manifest.auth.userCount)
    || manifest.auth.userCount < 0
    || !Number.isSafeInteger(manifest.auth.identityCount)
    || manifest.auth.identityCount < 0
    || !Number.isSafeInteger(manifest.auth.orphanIdentityCount)
    || manifest.auth.orphanIdentityCount < 0) {
    errors.push('Recovery bundle manifest records no Auth user count.');
  }
  if (!isPlainObject(manifest.dataEvidence)
    || manifest.dataEvidence.path !== 'evidence/data-evidence.json'
    || !SHA256_PATTERN.test(manifest.dataEvidence.sha256 ?? '')
    || !Number.isSafeInteger(manifest.dataEvidence.tableCount)
    || manifest.dataEvidence.tableCount <= 0) {
    errors.push('Recovery bundle manifest references no checksummed data evidence.');
  }
  if (!isPlainObject(manifest.gate4Evidence)
    || manifest.gate4Evidence.path !== 'evidence/gate4-source-evidence.json'
    || !SHA256_PATTERN.test(manifest.gate4Evidence.sha256 ?? '')) {
    errors.push('Recovery bundle manifest references no checksummed Gate 4 source evidence.');
  }

  validateDatabaseArtifacts(manifest, errors);
  validateMigrations(manifest, options, errors);
  validateStorage(manifest, errors);
  validateExecutionControl(manifest, errors);
  validateManagedSchemaCustomizations(manifest, errors);
  errors.push(...findSensitiveManifestContent(manifest));
  return errors;
}

export type StorageDifferenceKind =
  | 'MISSING_OBJECT'
  | 'EXTRA_OBJECT'
  | 'CHANGED_OBJECT'
  | 'WRONG_BUCKET'
  | 'CHANGED_CONTENT_TYPE';

export interface StorageDifference {
  kind: StorageDifferenceKind;
  bucket: string;
  /** Hashed key. Object names never leave the private manifest. */
  keyDigest: string;
}

function objectIdentity(record: StorageObjectRecord): string {
  return `${record.bucket} ${record.key}`;
}

/**
 * Compares the captured object set against what the restored target actually holds. Keys are
 * reported as digests so a drift report can be shown without disclosing private object names.
 */
export function compareStorageObjects(
  captured: readonly StorageObjectRecord[],
  restored: readonly StorageObjectRecord[],
): StorageDifference[] {
  const differences: StorageDifference[] = [];
  const restoredByIdentity = new Map(restored.map((record) => [objectIdentity(record), record]));
  const capturedByIdentity = new Map(captured.map((record) => [objectIdentity(record), record]));
  const capturedKeys = new Map<string, string>();
  for (const record of captured) capturedKeys.set(record.key, record.bucket);

  for (const record of captured) {
    const match = restoredByIdentity.get(objectIdentity(record));
    if (!match) {
      const elsewhere = restored.find((candidate) => candidate.key === record.key);
      differences.push({
        kind: elsewhere ? 'WRONG_BUCKET' : 'MISSING_OBJECT',
        bucket: record.bucket,
        keyDigest: sha256(record.key),
      });
      continue;
    }
    if (match.bytes !== record.bytes || match.sha256 !== record.sha256) {
      differences.push({ kind: 'CHANGED_OBJECT', bucket: record.bucket, keyDigest: sha256(record.key) });
      continue;
    }
    if (record.contentType !== null && match.contentType !== record.contentType) {
      differences.push({
        kind: 'CHANGED_CONTENT_TYPE',
        bucket: record.bucket,
        keyDigest: sha256(record.key),
      });
    }
  }

  for (const record of restored) {
    if (capturedByIdentity.has(objectIdentity(record))) continue;
    if (capturedKeys.has(record.key)) continue;
    differences.push({ kind: 'EXTRA_OBJECT', bucket: record.bucket, keyDigest: sha256(record.key) });
  }
  return differences;
}

export interface BucketConfigurationDifference {
  bucket: string;
  field: 'presence' | 'public' | 'fileSizeLimit' | 'allowedMimeTypes';
}

export function compareBucketConfiguration(
  captured: readonly BucketConfigurationEvidence[],
  restored: readonly BucketConfigurationEvidence[],
): BucketConfigurationDifference[] {
  const differences: BucketConfigurationDifference[] = [];
  const restoredById = new Map(restored.map((bucket) => [bucket.id, bucket]));
  for (const bucket of captured) {
    const match = restoredById.get(bucket.id);
    if (!match) {
      differences.push({ bucket: bucket.id, field: 'presence' });
      continue;
    }
    if (match.public !== bucket.public) differences.push({ bucket: bucket.id, field: 'public' });
    if ((match.fileSizeLimit ?? null) !== (bucket.fileSizeLimit ?? null)) {
      differences.push({ bucket: bucket.id, field: 'fileSizeLimit' });
    }
    const capturedTypes = bucket.allowedMimeTypes === null ? null : [...bucket.allowedMimeTypes].sort();
    const restoredTypes = match.allowedMimeTypes === null ? null : [...match.allowedMimeTypes].sort();
    if (JSON.stringify(capturedTypes) !== JSON.stringify(restoredTypes)) {
      differences.push({ bucket: bucket.id, field: 'allowedMimeTypes' });
    }
  }
  for (const bucket of restored) {
    if (!captured.some((candidate) => candidate.id === bucket.id)) {
      differences.push({ bucket: bucket.id, field: 'presence' });
    }
  }
  return differences;
}

export interface TableDataDifference {
  schema: string;
  table: string;
  field: 'presence' | 'rowCount' | 'checksum';
}

export function compareTableDataEvidence(
  captured: readonly TableDataEvidence[],
  restored: readonly TableDataEvidence[],
): TableDataDifference[] {
  const differences: TableDataDifference[] = [];
  const key = (evidence: Pick<TableDataEvidence, 'schema' | 'table'>): string =>
    `${evidence.schema}.${evidence.table}`;
  const restoredByKey = new Map(restored.map((evidence) => [key(evidence), evidence]));
  for (const evidence of captured) {
    const match = restoredByKey.get(key(evidence));
    if (!match) {
      differences.push({ schema: evidence.schema, table: evidence.table, field: 'presence' });
      continue;
    }
    if (match.rowCount !== evidence.rowCount) {
      differences.push({ schema: evidence.schema, table: evidence.table, field: 'rowCount' });
    }
    if (match.checksum !== evidence.checksum) {
      differences.push({ schema: evidence.schema, table: evidence.table, field: 'checksum' });
    }
  }
  for (const evidence of restored) {
    if (!captured.some((candidate) => key(candidate) === key(evidence))) {
      differences.push({ schema: evidence.schema, table: evidence.table, field: 'presence' });
    }
  }
  return differences;
}

export function compareExecutionControlEvidence(
  captured: ExecutionControlEvidence,
  restored: ExecutionControlEvidence,
): string[] {
  const differences: string[] = [];
  if (JSON.stringify(captured.budgetGuard) !== JSON.stringify(restored.budgetGuard)) {
    differences.push('Restored assistive launch budget guard does not match the captured guard.');
  }
  if (captured.launchReservationCount !== restored.launchReservationCount) {
    differences.push('Restored assistive launch reservation count does not match the capture.');
  }
  if (captured.executorRegistrationCount !== restored.executorRegistrationCount) {
    differences.push('Restored assistive executor registration count does not match the capture.');
  }
  if (captured.reservationChecksum !== restored.reservationChecksum) {
    differences.push('Restored assistive launch reservation history checksum does not match the capture.');
  }
  return differences;
}

export function compareAuthEvidence(
  captured: AuthRecoveryEvidence,
  restored: AuthRecoveryEvidence,
): string[] {
  const differences: string[] = [];
  if (captured.userCount !== restored.userCount) {
    differences.push('Restored Auth user count does not match the capture.');
  }
  if (captured.identityCount !== restored.identityCount) {
    differences.push('Restored Auth identity count does not match the capture.');
  }
  if (captured.orphanIdentityCount !== restored.orphanIdentityCount) {
    differences.push('Restored Auth relational-integrity count does not match the capture.');
  }
  if (restored.orphanIdentityCount !== 0) {
    differences.push('Restored Auth identities contain orphaned user references.');
  }
  return differences;
}
