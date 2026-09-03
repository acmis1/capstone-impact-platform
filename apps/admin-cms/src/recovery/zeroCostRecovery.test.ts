import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as disposableStack from './disposableSupabaseStack';
import * as gate4SchemaEvidence from '../deployment/gate4SchemaEvidence';
import * as gate4Collector from '../scripts/checkGate4SchemaEvidence';
import * as tableGrantCompatibility from './tableGrantPortabilityCompatibility';
import {
  compareBucketConfiguration,
  compareStorageObjects,
  sha256,
  summarizeBuckets,
  validateRecoveryBundleManifest,
  type BucketConfigurationEvidence,
  type RecoveryBundleManifest,
  type StorageObjectRecord,
} from './recoveryBundle';
import {
  BUNDLE_PATHS,
  PRIVATE_OBJECT_MANIFEST_FORMAT,
  bundleFile,
  loadRecoveryBundle,
  writeJsonArtifact,
  writeStorageObject,
} from './recoveryBundleStore';
import {
  buildDisposableSupabaseConfig,
  createDisposableStackIdentity,
  isApprovedDisposableManagedAuthOwnerCommand,
} from './disposableSupabaseStack';
import {
  applicationSmokeMatchesRecoveryContract,
  assertBundlePreserved,
  classifyRestoreFailure,
  runRestoreVerification,
  type ApplicationSmokeResult,
  type RestoreVerificationResult,
} from './restoreRecoveryRehearsal';
import { assertSafeObjectKey } from './storageTransfer';
import {
  APPROVED_HOSTED_SOURCE_PROJECT_REF,
  CANONICAL_STORAGE_BUCKETS,
  DATABASE_BACKUP_ARTIFACTS,
  RECOVERY_BUNDLE_FORMAT,
  RECOVERY_EVIDENCE_LABEL,
  RecoveryGuardError,
  assertApprovedHostedCaptureTarget,
  classifyBackupDirectory,
  resolveClassification,
} from './zeroCostRecoveryContract';
import { formatRestoreSummary } from '../scripts/restoreRecoveryBackup';
import { captureRecoveryBackup, repositoryMigrationVersions } from './captureRecoveryBackup';
import {
  APPLICATION_OWNED_TRIGGER_FUNCTION_SCHEMAS,
  buildApprovedManagedSchemaCustomizationRestoreSql,
  buildManagedSchemaCustomizationEvidenceSql,
  compareManagedSchemaCustomizations,
  inspectRepositoryManagedSchemaMigrationInventory,
  managedSchemaCustomizationCounts,
  REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
  scanManagedSchemaMigrationDdl,
  validateManagedSchemaCustomizationsAgainstRepository,
} from './managedSchemaCustomizations';
import {
  ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL,
  CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY,
  REMOVE_CUSTOM_CLAIMS_ALLOWLIST_FOR_SYNTHETIC_TARGET_SQL,
  deriveManagedAuthCopyRequirements,
  planManagedAuthSchemaCompatibility,
  type ManagedAuthCatalogColumn,
} from './managedAuthSchemaCompatibility';
import {
  EXPECTED_ROLE_COMPATIBILITY_TARGET_ROLES,
  KNOWN_PLATFORM_PARAMETER_ACL,
  planRoleParameterAclCompatibility,
} from './roleParameterAclCompatibility';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix = 'capstone-recovery-unit-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const bucketConfigurations: BucketConfigurationEvidence[] = CANONICAL_STORAGE_BUCKETS.map((id) => ({
  id,
  name: id,
  public: id !== 'project-drafts-private',
  fileSizeLimit: 50_000_000,
  allowedMimeTypes: id === 'public-feeds' ? ['application/json'] : ['image/png'],
}));

function objectRecord(bucket: string, key: string, content: Buffer): StorageObjectRecord {
  return {
    bucket,
    key,
    bytes: content.length,
    sha256: sha256(content),
    contentType: bucket === 'public-feeds' ? 'application/json' : 'image/png',
    lastModified: null,
    version: null,
  };
}

function buildBundle(): { directory: string; manifest: RecoveryBundleManifest; object: StorageObjectRecord } {
  const directory = temporaryDirectory();
  const database = DATABASE_BACKUP_ARTIFACTS.map((artifact) => {
    const content = Buffer.from(`-- synthetic ${artifact}\nSELECT 1;\n`, 'utf8');
    const file = bundleFile(directory, `${BUNDLE_PATHS.database}/${artifact}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { artifact, bytes: content.length, sha256: sha256(content) };
  });

  const content = Buffer.from('synthetic-private-object', 'utf8');
  const object = objectRecord('project-drafts-private', 'synthetic/private-object.png', content);
  writeStorageObject(directory, { record: object, content });
  const privateManifestChecksum = writeJsonArtifact(directory, BUNDLE_PATHS.privateObjectManifest, {
    formatVersion: PRIVATE_OBJECT_MANIFEST_FORMAT,
    classification: 'PRIVATE_RECOVERY_EVIDENCE_NEVER_COMMIT',
    objects: [object],
  });
  const dataEvidence = [{ schema: 'public', table: 'projects', rowCount: 1, checksum: 'a'.repeat(64) }];
  const dataEvidenceChecksum = writeJsonArtifact(directory, BUNDLE_PATHS.dataEvidence, dataEvidence);
  const gate4Checksum = writeJsonArtifact(directory, BUNDLE_PATHS.gate4Evidence, { formatVersion: 'test' });
  const managedSchemaChecksum = writeJsonArtifact(
    directory,
    BUNDLE_PATHS.managedSchemaCustomizations,
    REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
  );
  const manifest: RecoveryBundleManifest = {
    formatVersion: RECOVERY_BUNDLE_FORMAT,
    evidenceLabel: RECOVERY_EVIDENCE_LABEL,
    classification: 'ZERO_COST_HOSTED_ORIGIN_RECOVERY_BUNDLE',
    source: {
      kind: 'disposable-local-synthetic',
      projectRef: 'capstone-pp1-recovery-source-abcdef12',
      environmentLabel: 'disposable-local-synthetic',
      reviewedRepositoryGitSha: 'b'.repeat(40),
    },
    capture: {
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:01:00.000Z',
      supabaseCliVersion: '2.109.1',
      nodeVersion: 'v24.14.1',
    },
    postgres: { majorVersion: 15, reportedVersion: '15.synthetic' },
    migrations: { count: 1, latest: '20260831090000', versions: ['20260831090000'] },
    database,
    auth: { userCount: 1, identityCount: 1, orphanIdentityCount: 0 },
    storage: {
      buckets: summarizeBuckets(bucketConfigurations, [object]),
      privateObjectManifest: {
        path: BUNDLE_PATHS.privateObjectManifest,
        sha256: privateManifestChecksum,
        objectCount: 1,
      },
    },
    dataEvidence: {
      path: BUNDLE_PATHS.dataEvidence,
      sha256: dataEvidenceChecksum,
      tableCount: 1,
    },
    gate4Evidence: { path: BUNDLE_PATHS.gate4Evidence, sha256: gate4Checksum },
    managedSchemaCustomizations: {
      path: BUNDLE_PATHS.managedSchemaCustomizations,
      sha256: managedSchemaChecksum,
      authCount: 2,
      storageCount: 0,
    },
    executionControl: {
      budgetGuard: { environment: 'staging', launchLimit: 40, windowDays: 31, maxActiveExecutions: 1 },
      launchReservationCount: 2,
      executorRegistrationCount: 1,
      reservationChecksum: 'c'.repeat(64),
    },
  };
  writeJsonArtifact(directory, BUNDLE_PATHS.manifest, manifest);
  return { directory, manifest, object };
}

describe('hosted capture guard', () => {
  it('accepts only the exact approved requested and linked project ref', () => {
    expect(assertApprovedHostedCaptureTarget({
      requestedProjectRef: APPROVED_HOSTED_SOURCE_PROJECT_REF,
      linkedProjectRef: APPROVED_HOSTED_SOURCE_PROJECT_REF,
    })).toBe(APPROVED_HOSTED_SOURCE_PROJECT_REF);
  });

  it.each([
    ['fewcbklmbgzglfgedtvt', 'HISTORICAL_STAGING_PROJECT_REFUSED'],
    ['bpnmrgmzgbisvykppuwp', 'PROTOTYPE_RECOVERY_PROJECT_REFUSED'],
    ['aaaaaaaaaaaaaaaaaaaa', 'REQUESTED_PROJECT_REF_NOT_APPROVED'],
    ['', 'REQUESTED_PROJECT_REF_MISSING'],
  ])('rejects refused or unknown requested ref %s', (requestedProjectRef, code) => {
    expect(() => assertApprovedHostedCaptureTarget({
      requestedProjectRef,
      linkedProjectRef: APPROVED_HOSTED_SOURCE_PROJECT_REF,
    })).toThrowError(code);
  });

  it('rejects a missing or mismatched linked project instead of relinking', () => {
    expect(() => assertApprovedHostedCaptureTarget({
      requestedProjectRef: APPROVED_HOSTED_SOURCE_PROJECT_REF,
      linkedProjectRef: null,
    })).toThrowError('LINKED_PROJECT_REF_MISSING');
    expect(() => assertApprovedHostedCaptureTarget({
      requestedProjectRef: APPROVED_HOSTED_SOURCE_PROJECT_REF,
      linkedProjectRef: 'aaaaaaaaaaaaaaaaaaaa',
    })).toThrowError('LINKED_PROJECT_REF_NOT_APPROVED');
  });
});

describe('private backup path guard', () => {
  it('rejects repository, worktree, tracked and non-empty destinations', () => {
    const repositoryRoot = path.resolve('repository');
    expect(classifyBackupDirectory({
      directory: path.join(repositoryRoot, 'backup'),
      repositoryRoot,
      gitToplevel: null,
      trackedFileCount: 0,
      existingEntryCount: 0,
    })).toEqual({ ok: false, reason: 'BACKUP_DIRECTORY_INSIDE_REPOSITORY' });
    expect(classifyBackupDirectory({
      directory: path.resolve('external-backup'),
      repositoryRoot,
      gitToplevel: path.resolve('another-worktree'),
      trackedFileCount: 0,
      existingEntryCount: 0,
    })).toEqual({ ok: false, reason: 'BACKUP_DIRECTORY_INSIDE_GIT_WORKTREE' });
    expect(classifyBackupDirectory({
      directory: path.resolve('external-backup'),
      repositoryRoot,
      gitToplevel: null,
      trackedFileCount: 1,
      existingEntryCount: 0,
    })).toEqual({ ok: false, reason: 'BACKUP_DIRECTORY_CONTAINS_TRACKED_FILES' });
    expect(classifyBackupDirectory({
      directory: path.resolve('external-backup'),
      repositoryRoot,
      gitToplevel: null,
      trackedFileCount: 0,
      existingEntryCount: 1,
    })).toEqual({ ok: false, reason: 'BACKUP_DIRECTORY_NOT_EMPTY' });
  });

  it('rejects bundle path traversal', () => {
    expect(() => bundleFile(temporaryDirectory(), '../escape')).toThrowError('RECOVERY_BUNDLE_PATH_UNSAFE');
  });
});

describe('bundle manifest and artifact integrity', () => {
  it('loads a complete bundle and preserves it', () => {
    const { directory, manifest } = buildBundle();
    expect(validateRecoveryBundleManifest(manifest)).toEqual([]);
    expect(loadRecoveryBundle(directory).manifest).toEqual(manifest);
    expect(assertBundlePreserved(directory)).toBe(true);
  });

  it('rejects a required database artifact that is missing or corrupt', () => {
    const missing = buildBundle();
    fs.rmSync(bundleFile(missing.directory, `${BUNDLE_PATHS.database}/data.sql`));
    expect(() => loadRecoveryBundle(missing.directory)).toThrowError('RECOVERY_BUNDLE_ARTIFACT_MISSING:data.sql');

    const corrupt = buildBundle();
    fs.appendFileSync(bundleFile(corrupt.directory, `${BUNDLE_PATHS.database}/schema.sql`), 'tampered');
    expect(() => loadRecoveryBundle(corrupt.directory)).toThrowError('RECOVERY_BUNDLE_ARTIFACT_CORRUPTED:schema.sql');
  });

  it('keeps checksum validation authoritative before supported compatibility parsing', () => {
    const bundle = buildBundle();
    fs.appendFileSync(
      bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/data.sql`),
      '\nCOPY auth.custom_oauth_providers (id, custom_claims_allowlist) FROM stdin;\n\\.\n',
    );
    expect(() => loadRecoveryBundle(bundle.directory))
      .toThrowError('RECOVERY_BUNDLE_ARTIFACT_CORRUPTED:data.sql');
  });

  it('rejects corrupted Storage bytes before upload', () => {
    const bundle = buildBundle();
    fs.writeFileSync(
      path.join(bundleFile(bundle.directory, BUNDLE_PATHS.objects), bundle.object.sha256),
      Buffer.alloc(bundle.object.bytes, 0xff),
    );
    expect(() => loadRecoveryBundle(bundle.directory))
      .toThrowError('RECOVERY_BUNDLE_STORAGE_OBJECT_CORRUPTED');

    const missing = buildBundle();
    fs.rmSync(path.join(bundleFile(missing.directory, BUNDLE_PATHS.objects), missing.object.sha256));
    expect(() => loadRecoveryBundle(missing.directory))
      .toThrowError('RECOVERY_BUNDLE_STORAGE_OBJECT_MISSING');
  });

  it('rejects structurally invalid non-content table evidence', () => {
    const bundle = buildBundle();
    const invalidEvidence = [{ schema: 'public', table: '../projects', rowCount: -1, checksum: 'nope' }];
    const checksum = writeJsonArtifact(bundle.directory, BUNDLE_PATHS.dataEvidence, invalidEvidence);
    bundle.manifest.dataEvidence = { ...bundle.manifest.dataEvidence, sha256: checksum };
    writeJsonArtifact(bundle.directory, BUNDLE_PATHS.manifest, bundle.manifest);
    expect(() => loadRecoveryBundle(bundle.directory))
      .toThrowError('RECOVERY_BUNDLE_DATA_EVIDENCE_INVALID');
  });

  it('rejects missing or inconsistent migration history', () => {
    const { manifest } = buildBundle();
    expect(validateRecoveryBundleManifest({ ...manifest, migrations: { count: 0, latest: '', versions: [] } }))
      .toContain('Recovery bundle records no migration-history evidence.');
    expect(validateRecoveryBundleManifest({
      ...manifest,
      migrations: { ...manifest.migrations, latest: '20260830000000' },
    })).toContain('Recovery bundle latest migration does not match the recorded migration versions.');
  });

  it('rejects a missing canonical bucket or assistive cost-fence state', () => {
    const { manifest } = buildBundle();
    expect(validateRecoveryBundleManifest({
      ...manifest,
      storage: { ...manifest.storage, buckets: manifest.storage.buckets.slice(1) },
    })).toContain('Recovery bundle does not cover exactly the three canonical Storage buckets.');
    expect(validateRecoveryBundleManifest({
      ...manifest,
      executionControl: { ...manifest.executionControl, budgetGuard: null },
    })).toContain('Recovery bundle records no assistive launch budget guard row.');
  });
});

function managedEvidenceFixture() {
  return JSON.parse(JSON.stringify(REPOSITORY_MANAGED_SCHEMA_EXPECTATION)) as typeof REPOSITORY_MANAGED_SCHEMA_EXPECTATION;
}

describe('managed auth/storage customization recovery boundary', () => {
  const repositoryRoot = path.resolve(__dirname, '../../../..');

  it('collects every application-owned managed trigger without filtering by expected names', () => {
    const sql = buildManagedSchemaCustomizationEvidenceSql();
    expect(APPLICATION_OWNED_TRIGGER_FUNCTION_SCHEMAS).toEqual(['public']);
    expect(sql).toContain("relation_namespace.nspname IN ('auth', 'storage')");
    expect(sql).toContain('AND NOT trigger_definition.tgisinternal');
    expect(sql).toMatch(/function_namespace\.nspname IN \('public'\)/);
    expect(sql).not.toMatch(/trigger_definition\.tgname IN/);
    expect(sql).not.toMatch(/function_namespace\.nspname IN \([^)]*'storage'/);
    for (const trigger of REPOSITORY_MANAGED_SCHEMA_EXPECTATION.triggers) {
      expect(trigger.functionSchema).toBe('public');
      expect(sql).not.toContain(trigger.name);
    }
  });

  it('inventories exactly both current Auth triggers and no custom Storage object across 50 migrations', () => {
    const operations = inspectRepositoryManagedSchemaMigrationInventory(repositoryRoot);
    const creates = operations.filter((operation) => operation.action === 'CREATE_TRIGGER');
    expect(repositoryMigrationVersions(repositoryRoot)).toHaveLength(50);
    expect(creates.map((operation) => `${operation.schema}.${operation.table}.${operation.name}`))
      .toEqual([
        'auth.users.claim_staff_provisioning_auth_insert_before_insert',
        'auth.users.claim_staff_provisioning_auth_insert_before_metadata_update',
      ]);
    expect(operations.some((operation) => operation.schema === 'storage')).toBe(false);
    expect(managedSchemaCustomizationCounts(REPOSITORY_MANAGED_SCHEMA_EXPECTATION))
      .toEqual({ auth: 2, storage: 0 });
  });

  it('matches exact source definitions to the repository expectation without identity rows', () => {
    const evidence = managedEvidenceFixture();
    expect(validateManagedSchemaCustomizationsAgainstRepository(evidence)).toEqual([]);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    expect(serialized).not.toContain('userCount');
    expect(serialized).not.toContain('raw_user_meta_data":"');
  });

  it('fails source evidence when either Auth trigger is missing', () => {
    for (let index = 0; index < 2; index += 1) {
      const evidence = managedEvidenceFixture();
      evidence.triggers.splice(index, 1);
      expect(validateManagedSchemaCustomizationsAgainstRepository(evidence))
        .toContain(`MISSING:auth.users.${REPOSITORY_MANAGED_SCHEMA_EXPECTATION.triggers[index].name}`);
    }
  });

  it('reports a differently named application-owned Auth trigger as unexpected', () => {
    const evidence = managedEvidenceFixture();
    evidence.triggers.push({
      ...evidence.triggers[0],
      name: 'unexpected_application_auth_trigger',
      functionName: 'unexpected_application_auth_hook',
      definition: `
        CREATE TRIGGER unexpected_application_auth_trigger
        BEFORE INSERT ON auth.users
        FOR EACH ROW EXECUTE FUNCTION public.unexpected_application_auth_hook()
      `,
    });
    expect(validateManagedSchemaCustomizationsAgainstRepository(evidence))
      .toContain('UNEXPECTED:auth.users.unexpected_application_auth_trigger');
  });

  it('reports a public-function Storage trigger as unexpected instead of treating it as provider-owned', () => {
    const evidence = managedEvidenceFixture();
    evidence.triggers.push({
      ...evidence.triggers[0],
      schema: 'storage',
      table: 'objects',
      name: 'unexpected_application_storage_trigger',
      functionName: 'unexpected_application_storage_hook',
      definition: `
        CREATE TRIGGER unexpected_application_storage_trigger
        BEFORE INSERT ON storage.objects
        FOR EACH ROW EXECUTE FUNCTION public.unexpected_application_storage_hook()
      `,
    });
    expect(validateManagedSchemaCustomizationsAgainstRepository(evidence))
      .toContain('UNEXPECTED:storage.objects.unexpected_application_storage_trigger');
    expect(managedSchemaCustomizationCounts(evidence)).toEqual({ auth: 2, storage: 1 });
  });

  it.each([
    ['event', (evidence: ReturnType<typeof managedEvidenceFixture>) => { evidence.triggers[0].events = ['DELETE']; }],
    ['definition', (evidence: ReturnType<typeof managedEvidenceFixture>) => { evidence.triggers[0].definition = evidence.triggers[0].definition.replace('before insert', 'after insert'); }],
    ['function', (evidence: ReturnType<typeof managedEvidenceFixture>) => { evidence.triggers[0].functionName = 'unknown_trigger_function'; }],
  ])('fails altered trigger %s semantics', (_field, mutate) => {
    const evidence = managedEvidenceFixture();
    mutate(evidence);
    expect(validateManagedSchemaCustomizationsAgainstRepository(evidence).length).toBeGreaterThan(0);
  });

  it('fails restored-target comparison when either required trigger is absent', () => {
    for (let index = 0; index < 2; index += 1) {
      const restored = managedEvidenceFixture();
      restored.triggers.splice(index, 1);
      expect(compareManagedSchemaCustomizations(REPOSITORY_MANAGED_SCHEMA_EXPECTATION, restored))
        .toMatchObject([{ kind: 'MISSING' }]);
    }
  });

  it('cannot false-green 50/50 migration history when a managed Auth trigger is absent', () => {
    const migrations = repositoryMigrationVersions(repositoryRoot);
    const restored = managedEvidenceFixture();
    restored.triggers.pop();
    const managedDrift = compareManagedSchemaCustomizations(
      REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
      restored,
    );
    expect(migrations).toHaveLength(50);
    expect(resolveClassification(
      managedDrift.length > 0 ? ['MANAGED_SCHEMA_CUSTOMIZATION_DRIFT'] : [],
    )).toBe('MANAGED_SCHEMA_CUSTOMIZATION_DRIFT');
  });

  it('cannot false-green Gate 4 MATCH when a managed Auth trigger is absent', () => {
    const gate4Classification = 'GATE4_MATCH';
    const restored = managedEvidenceFixture();
    restored.triggers.shift();
    const managedDrift = compareManagedSchemaCustomizations(
      REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
      restored,
    );
    expect(gate4Classification).toBe('GATE4_MATCH');
    expect(resolveClassification(
      managedDrift.length > 0 ? ['MANAGED_SCHEMA_CUSTOMIZATION_DRIFT'] : [],
    )).not.toBe('ZERO_COST_RECOVERY_REHEARSAL_VERIFIED');
  });

  it('matches exact captured and restored customization evidence', () => {
    expect(compareManagedSchemaCustomizations(
      managedEvidenceFixture(),
      managedEvidenceFixture(),
    )).toEqual([]);
  });

  it('fails closed for an unreviewed future managed-schema customization', () => {
    expect(scanManagedSchemaMigrationDdl(`
      CREATE POLICY future_private_policy ON storage.objects FOR SELECT USING (false);
    `)).toMatchObject([{ action: 'UNREVIEWED_MANAGED_DDL', schema: 'storage' }]);
    expect(scanManagedSchemaMigrationDdl(`
      DO $$ BEGIN
        EXECUTE 'ALTER TABLE auth.users ADD COLUMN unsafe text';
      END $$;
    `)).toMatchObject([{ action: 'UNREVIEWED_MANAGED_DDL', name: 'dynamic-sql' }]);
  });

  it('does not misclassify ordinary Auth reads, helpers, or foreign-key references', () => {
    expect(scanManagedSchemaMigrationDdl(`
      CREATE TABLE public.example (
        user_id uuid REFERENCES auth.users(id),
        session_id uuid REFERENCES auth.sessions(id)
      );
      SELECT id FROM auth.users;
      SELECT auth.uid();
    `)).toEqual([]);
  });

  it('never executes unknown bundle SQL and returns only the fixed approved restore DDL', () => {
    const unknown = managedEvidenceFixture();
    unknown.triggers[0].definition += '; DROP TABLE auth.users';
    expect(() => buildApprovedManagedSchemaCustomizationRestoreSql(unknown))
      .toThrowError('MANAGED_SCHEMA_CUSTOMIZATION_NOT_APPROVED');
    const approvedSql = buildApprovedManagedSchemaCustomizationRestoreSql(managedEvidenceFixture());
    expect(approvedSql).toContain('MANAGED_AUTH_TRIGGER_FUNCTION_MISSING_OR_DIFFERENT');
    expect(approvedSql.match(/CREATE TRIGGER/g)).toHaveLength(2);
    expect(approvedSql).not.toContain('DROP TABLE');
  });
});

const hostedAheadAuthDataSql = `
COPY auth.custom_oauth_providers (id, identifier, custom_claims_allowlist) FROM stdin;
\\.
COPY auth.users (id, email) FROM stdin;
\\.
RESET ALL;
`.trim();

const unsupportedCopyHeaders = [
  ['Unicode-escaped schema', 'COPY U&"auth".future_table (id) FROM stdin;'],
  ['comment after COPY', 'COPY/*comment*/auth.users (id) FROM stdin;'],
  ['comment before table', 'COPY auth./*comment*/users (id) FROM stdin;'],
  ['unterminated schema', 'COPY "unterminated.users (id) FROM stdin;'],
  ['malformed quoted Auth schema', 'COPY "auth"junk.users (id) FROM stdin;'],
  ['query COPY', 'COPY (SELECT 1) TO STDOUT;'],
  ['query COPY with trailing SQL', 'COPY (SELECT 1) TO STDOUT; CREATE TABLE auth.review_unapproved (id integer);'],
  ['table COPY with trailing SQL', 'COPY public.projects (id) FROM stdin; CREATE TABLE auth.bad (id integer);'],
  ['quoted non-Auth schema with trailing SQL', 'COPY "Auth".users (id) FROM stdin; SELECT 1;'],
  ['malformed Auth column', 'COPY "auth".users (id; select) FROM stdin;'],
  ['empty Auth columns', 'COPY auth.users () FROM stdin;'],
  ['malformed non-Auth columns', 'COPY public.projects (id,) FROM stdin;'],
] as const;

function managedAuthTargetColumns(): ManagedAuthCatalogColumn[] {
  return [
    {
      table: 'custom_oauth_providers',
      column: 'id',
      formattedType: 'uuid',
      notNull: true,
      defaultExpression: 'gen_random_uuid()',
    },
    {
      table: 'custom_oauth_providers',
      column: 'identifier',
      formattedType: 'text',
      notNull: true,
      defaultExpression: null,
    },
    {
      table: 'users',
      column: 'id',
      formattedType: 'uuid',
      notNull: true,
      defaultExpression: null,
    },
    {
      table: 'users',
      column: 'email',
      formattedType: 'character varying(255)',
      notNull: false,
      defaultExpression: null,
    },
  ];
}

describe('managed Auth provider-schema compatibility', () => {
  it.each([
    ['quoted table', 'public."ProjectItems" (id)'],
    ['quoted column', 'public.projects ("ProjectTitle")'],
    ['distinct quoted schema', '"Auth"."Users" ("Email")'],
    ['distinct quoted schema with ordinary table', '"Auth".users (id)'],
    ['quoted punctuation and escaped quote', '"Other.Schema"."Project""Items" ("Title, (Public)", id)'],
  ])('ignores non-Auth COPY identifiers: %s', (_label, target) => {
    const requirements = deriveManagedAuthCopyRequirements(
      `COPY ${target} FROM stdin;\nrow body is not SQL\n\\.\n${hostedAheadAuthDataSql}`,
    );
    expect(requirements).toEqual(deriveManagedAuthCopyRequirements(hostedAheadAuthDataSql));
    expect(planManagedAuthSchemaCompatibility(requirements, managedAuthTargetColumns()))
      .toMatchObject({ action: 'ADD_CUSTOM_CLAIMS_ALLOWLIST' });
  });

  it.each(['AUTH', 'Auth', '"auth"'])('recognizes PostgreSQL Auth schema spelling %s', (schema) => {
    expect(deriveManagedAuthCopyRequirements(`COPY ${schema}.users (id, email) FROM stdin;\n\\.`))
      .toEqual([{ table: 'users', columns: ['id', 'email'] }]);
  });

  it.each([
    'auth."UnsafeTable" (id)',
    'auth.users ("UnsafeColumn")',
    'AUTH."unsafe-table" (id)',
    'auth.users (id, id)',
    'auth.users (id, "id")',
  ])('fails closed for invalid Auth COPY structure %s', (target) => {
    expect(() => deriveManagedAuthCopyRequirements(`COPY ${target} FROM stdin;\n\\.`))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_INVALID');
  });

  it.each(unsupportedCopyHeaders)('rejects unsupported COPY syntax: %s', (_label, header) => {
    expect(() => deriveManagedAuthCopyRequirements(`${hostedAheadAuthDataSql}\n${header}\n\\.`))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_UNSUPPORTED');
  });

  it.each(['\n', '\r\n'])('keeps COPY rows opaque through the exact terminator (%#)', (newline) => {
    const data = [
      'COPY public.projects (id) FROM stdin;',
      ...unsupportedCopyHeaders.map(([, header]) => header),
      'COPY auth.future_table (unknown_column) FROM stdin;',
      ' \\.',
      '\\.',
      hostedAheadAuthDataSql,
    ].join('\n').replaceAll('\n', newline);
    expect(deriveManagedAuthCopyRequirements(data))
      .toEqual(deriveManagedAuthCopyRequirements(hostedAheadAuthDataSql));
  });

  it.each([
    ['Auth missing terminator', 'COPY auth.sessions (id) FROM stdin;\nrow'],
    ['non-Auth missing terminator', 'COPY public.projects (id) FROM stdin;\nrow'],
    ['leading space on terminator', 'COPY public.projects (id) FROM stdin;\n \\.'],
    ['trailing space on terminator', 'COPY public.projects (id) FROM stdin;\n\\. '],
    ['trailing tab on terminator', 'COPY public.projects (id) FROM stdin;\n\\.\t'],
  ])('rejects incomplete COPY data: %s', (_label, block) => {
    expect(() => deriveManagedAuthCopyRequirements(`${hostedAheadAuthDataSql}\n${block}`))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_COPY_DATA_TRUNCATED');
  });

  it.each([
    ...unsupportedCopyHeaders,
    ['sensitive unsupported COPY', 'COPY U&"__SENSITIVE__".users (id) FROM stdin;'],
  ] as const)(
    'rejects before production data replay and preserves diagnostics: %s',
    async (_label, header) => {
      const bundle = buildBundle();
      const sensitiveToken = `SECRETTOKEN_${randomBytes(16).toString('hex')}`;
      const content = Buffer.from(`${hostedAheadAuthDataSql}\n${header.replace('__SENSITIVE__', sensitiveToken)}\n\\.\n`);
      const dataFile = bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/data.sql`);
      fs.writeFileSync(dataFile, content);
      const dataArtifact = bundle.manifest.database.find((entry) => entry.artifact === 'data.sql')!;
      dataArtifact.bytes = content.length;
      dataArtifact.sha256 = sha256(content);
      writeJsonArtifact(bundle.directory, BUNDLE_PATHS.manifest, bundle.manifest);
      const manifestBefore = fs.readFileSync(bundleFile(bundle.directory, BUNDLE_PATHS.manifest));

      // Keep real private-path, manifest and checksum validation; isolate Gate 4 and Docker here.
      // The full synthetic rehearsal exercises those external boundaries without mocks.
      const gate4 = vi.spyOn(gate4SchemaEvidence, 'validateCurrentRepositoryGate4Contract')
        .mockReturnValue([]);
      vi.spyOn(gate4Collector, 'collectLocalGate4Evidence').mockReturnValue({});
      vi.spyOn(tableGrantCompatibility, 'planTableGrantPortabilityCompatibility')
        .mockReturnValue({ action: 'MATCH', revokeCount: 0, sql: null });
      vi.spyOn(disposableStack, 'createDisposableNetwork').mockReturnValue('unit-network');
      vi.spyOn(disposableStack, 'startDisposableStack').mockImplementation(() => {});
      vi.spyOn(disposableStack, 'stopDisposableStack').mockImplementation(() => {});
      vi.spyOn(disposableStack, 'prepareDisposableContainerStaging').mockReturnValue('/tmp/recovery');
      vi.spyOn(disposableStack, 'copyFileIntoDisposableContainer').mockImplementation(() => {});
      const cleanup = vi.spyOn(disposableStack, 'removeDisposableResidue').mockImplementation((identity) => {
        temporaryDirectories.push(identity.workdir);
      });
      vi.spyOn(disposableStack, 'inspectDisposableResidue').mockReturnValue({
        containers: [], volumes: [], networks: [], workdirPresent: false,
      });
      const psql = vi.spyOn(disposableStack, 'runDisposablePsql').mockReturnValue('');
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      let rejected: unknown;
      try {
        deriveManagedAuthCopyRequirements(content.toString('utf8'));
      } catch (error) {
        rejected = error;
      }
      expect(rejected instanceof RecoveryGuardError).toBe(true);
      const failure = rejected as RecoveryGuardError;
      expect(failure.code === 'MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_UNSUPPORTED').toBe(true);
      expect(failure.message === failure.code).toBe(true);
      expect(String(failure).includes(sensitiveToken)).toBe(false);

      const result = await runRestoreVerification({
        repositoryRoot: path.resolve(__dirname, '../../../..'),
        bundleDirectory: bundle.directory,
      });
      expect(gate4).toHaveBeenCalledOnce();
      expect(result.classification).toBe('MANAGED_AUTH_COMPATIBILITY_FAILED');
      expect(result.findings.every((finding) => finding === failure.code)).toBe(true);
      expect(result.findings).toHaveLength(1);
      // Only schema replay ran: neither catalog/alignment SQL nor data replay reached psql.
      expect(psql).toHaveBeenCalledOnce();
      expect(psql.mock.calls[0][1].files).toEqual([
        '/tmp/recovery/roles.sql', '/tmp/recovery/schema.sql', '/tmp/recovery/migrations-schema.sql',
      ]);
      expect(cleanup).toHaveBeenCalledOnce();
      const summary = formatRestoreSummary(result, assertBundlePreserved(bundle.directory));
      expect(summary.includes(sensitiveToken)).toBe(false);
      expect(summary).toContain('FINDING = MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_UNSUPPORTED');
      expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls]).includes(sensitiveToken)).toBe(false);
      expect(fs.readFileSync(dataFile).equals(content)).toBe(true);
      expect(fs.readFileSync(bundleFile(bundle.directory, BUNDLE_PATHS.manifest)).equals(manifestBefore)).toBe(true);
    },
  );

  it('still refuses duplicate and missing Auth COPY structure', () => {
    expect(() => deriveManagedAuthCopyRequirements(`${hostedAheadAuthDataSql}\n${hostedAheadAuthDataSql}`))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_COPY_HEADER_DUPLICATE');
    expect(() => deriveManagedAuthCopyRequirements('COPY "Auth".users (id) FROM stdin;\n\\.'))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_SOURCE_REQUIREMENTS_MISSING');
    expect(() => planManagedAuthSchemaCompatibility(
      [{ table: 'unknown_auth_table', columns: ['id'] }], managedAuthTargetColumns(),
    )).toThrowError('MANAGED_AUTH_COMPATIBILITY_UNKNOWN_DRIFT');
  });

  it('derives only COPY structure and selects the one reviewed hosted-ahead delta', () => {
    const requirements = deriveManagedAuthCopyRequirements(hostedAheadAuthDataSql);
    expect(requirements).toEqual([
      {
        table: 'custom_oauth_providers',
        columns: ['id', 'identifier', 'custom_claims_allowlist'],
      },
      { table: 'users', columns: ['id', 'email'] },
    ]);
    expect(planManagedAuthSchemaCompatibility(requirements, managedAuthTargetColumns()))
      .toMatchObject({ action: 'ADD_CUSTOM_CLAIMS_ALLOWLIST' });
    expect(ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL).toBe(
      "alter table auth.custom_oauth_providers\n"
      + "    add column if not exists custom_claims_allowlist text[] not null default '{}';",
    );
  });

  it('requires the exact structural result after the known delta is present', () => {
    const requirements = deriveManagedAuthCopyRequirements(hostedAheadAuthDataSql);
    const target = [
      ...managedAuthTargetColumns(),
      { ...CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY },
    ];
    expect(planManagedAuthSchemaCompatibility(requirements, target))
      .toMatchObject({ action: 'MATCH', requiredTableCount: 2, requiredColumnCount: 5 });
  });

  it('fails closed for an unknown source-ahead Auth column', () => {
    const requirements = deriveManagedAuthCopyRequirements(`
COPY auth.custom_oauth_providers (id, identifier, future_unreviewed_column) FROM stdin;
\\.
    `.trim());
    expect(() => planManagedAuthSchemaCompatibility(requirements, managedAuthTargetColumns()))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_UNKNOWN_DRIFT');
  });

  it.each([
    ['type', { formattedType: 'jsonb' }],
    ['nullability', { notNull: false }],
    ['default', { defaultExpression: null }],
  ])('rejects the known compatibility column with wrong %s', (_field, change) => {
    const requirements = deriveManagedAuthCopyRequirements(hostedAheadAuthDataSql);
    const target = [
      ...managedAuthTargetColumns(),
      { ...CUSTOM_CLAIMS_ALLOWLIST_COMPATIBILITY, ...change },
    ];
    expect(() => planManagedAuthSchemaCompatibility(requirements, target))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_KNOWN_DELTA_SHAPE_MISMATCH');
  });

  it('never accepts arbitrary managed Auth DDL from the data artifact', () => {
    expect(() => deriveManagedAuthCopyRequirements(`${hostedAheadAuthDataSql}\n`
      + 'ALTER TABLE auth.users ADD COLUMN arbitrary_bundle_sql text;'))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_UNSAFE_AUTH_STATEMENT');
    expect(() => deriveManagedAuthCopyRequirements(`${hostedAheadAuthDataSql}\n`
      + 'SET search_path = auth;\nALTER TABLE users ADD COLUMN arbitrary_bundle_sql text;'))
      .toThrowError('MANAGED_AUTH_COMPATIBILITY_DATA_DUMP_STATEMENT_UNSUPPORTED');
    expect(isApprovedDisposableManagedAuthOwnerCommand(ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL)).toBe(true);
    expect(isApprovedDisposableManagedAuthOwnerCommand(
      REMOVE_CUSTOM_CLAIMS_ALLOWLIST_FOR_SYNTHETIC_TARGET_SQL,
    )).toBe(true);
    expect(isApprovedDisposableManagedAuthOwnerCommand(
      'ALTER TABLE auth.users ADD COLUMN arbitrary_bundle_sql text;',
    )).toBe(false);
    expect(ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL).not.toContain('arbitrary_bundle_sql');
  });
});

const KNOWN_PLATFORM_GRANT = KNOWN_PLATFORM_PARAMETER_ACL.canonicalStatements[0];

/** Minimal shape of a pinned-CLI role-only dump: reserved roles filtered, trailing RESET ALL. */
function roleDumpFixture(parameterAclStatements: readonly string[] = []): string {
  return [
    'SET default_transaction_read_only = off;',
    'CREATE ROLE "capstone_reporting";',
    'GRANT "anon" TO "authenticator" WITH INHERIT FALSE GRANTED BY "supabase_admin";',
    ...parameterAclStatements,
    'RESET ALL;',
    '',
  ].join('\n');
}

function rewriteBundleArtifact(
  bundle: ReturnType<typeof buildBundle>,
  artifact: string,
  content: Buffer,
): void {
  fs.writeFileSync(bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/${artifact}`), content);
  const recorded = bundle.manifest.database.find((entry) => entry.artifact === artifact);
  if (!recorded) throw new Error('UNKNOWN_TEST_ARTIFACT');
  recorded.bytes = content.length;
  recorded.sha256 = sha256(content);
  writeJsonArtifact(bundle.directory, BUNDLE_PATHS.manifest, bundle.manifest);
}

/** Isolates Gate 4 and Docker only; private-path, manifest and checksum validation stay real. */
function mockDisposableBoundaries() {
  vi.spyOn(gate4SchemaEvidence, 'validateCurrentRepositoryGate4Contract').mockReturnValue([]);
  vi.spyOn(gate4Collector, 'collectLocalGate4Evidence').mockReturnValue({});
  vi.spyOn(tableGrantCompatibility, 'planTableGrantPortabilityCompatibility')
    .mockReturnValue({ action: 'MATCH', revokeCount: 0, sql: null });
  return {
    network: vi.spyOn(disposableStack, 'createDisposableNetwork').mockReturnValue('unit-network'),
    start: vi.spyOn(disposableStack, 'startDisposableStack').mockImplementation(() => {}),
    stop: vi.spyOn(disposableStack, 'stopDisposableStack').mockImplementation(() => {}),
    staging: vi.spyOn(disposableStack, 'prepareDisposableContainerStaging')
      .mockReturnValue('/tmp/recovery'),
    copied: vi.spyOn(disposableStack, 'copyFileIntoDisposableContainer').mockImplementation(() => {}),
    cleanup: vi.spyOn(disposableStack, 'removeDisposableResidue').mockImplementation((identity) => {
      temporaryDirectories.push(identity.workdir);
    }),
    residue: vi.spyOn(disposableStack, 'inspectDisposableResidue').mockReturnValue({
      containers: [], volumes: [], networks: [], workdirPresent: false,
    }),
    stdout: vi.spyOn(process.stdout, 'write').mockReturnValue(true),
    stderr: vi.spyOn(process.stderr, 'write').mockReturnValue(true),
  };
}

describe('provider-global role parameter ACL restore path', () => {
  it('keeps roles.sql checksum validation authoritative before compatibility parsing', () => {
    const bundle = buildBundle();
    fs.appendFileSync(
      bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/roles.sql`),
      `\n${KNOWN_PLATFORM_GRANT}\n`,
    );
    expect(() => loadRecoveryBundle(bundle.directory))
      .toThrowError('RECOVERY_BUNDLE_ARTIFACT_CORRUPTED:roles.sql');
  });

  it('refuses an unreviewed provider parameter ACL before any disposable target starts', async () => {
    const bundle = buildBundle();
    const sensitiveToken = `SECRETTOKEN_${randomBytes(16).toString('hex').toUpperCase()}`;
    const content = Buffer.from(roleDumpFixture([
      `GRANT SET ON PARAMETER "${sensitiveToken}" TO "supabase_realtime_admin";`,
    ]), 'utf8');
    rewriteBundleArtifact(bundle, 'roles.sql', content);
    const rolesFile = bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/roles.sql`);
    const manifestFile = bundleFile(bundle.directory, BUNDLE_PATHS.manifest);
    const manifestBefore = fs.readFileSync(manifestFile);
    const boundaries = mockDisposableBoundaries();
    const psql = vi.spyOn(disposableStack, 'runDisposablePsql').mockReturnValue('');

    const result = await runRestoreVerification({
      repositoryRoot: path.resolve(__dirname, '../../../..'),
      bundleDirectory: bundle.directory,
    });

    expect(result.classification).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED');
    expect(result.roleParameterAclCompatibility).toBe('NOT_RUN');
    expect(result.findings).toEqual(['ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED']);
    // No target was created, started, staged, or replayed against.
    expect(boundaries.network).not.toHaveBeenCalled();
    expect(boundaries.start).not.toHaveBeenCalled();
    expect(boundaries.staging).not.toHaveBeenCalled();
    expect(boundaries.copied).not.toHaveBeenCalled();
    expect(psql).not.toHaveBeenCalled();
    expect(boundaries.cleanup).toHaveBeenCalledOnce();

    const summary = formatRestoreSummary(result, assertBundlePreserved(bundle.directory));
    expect(summary.includes(sensitiveToken)).toBe(false);
    expect(summary).toContain('ROLE_PLATFORM_ACL_COMPATIBILITY = NOT_RUN');
    expect(summary).toContain('FINDING = ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED');
    expect(JSON.stringify([
      ...boundaries.stdout.mock.calls,
      ...boundaries.stderr.mock.calls,
    ]).includes(sensitiveToken)).toBe(false);
    expect(fs.readFileSync(rolesFile).equals(content)).toBe(true);
    expect(fs.readFileSync(manifestFile).equals(manifestBefore)).toBe(true);
  });

  it('replays a verifier-owned normalized copy and never rewrites the bundle', async () => {
    const bundle = buildBundle();
    const content = Buffer.from(roleDumpFixture([KNOWN_PLATFORM_GRANT]), 'utf8');
    rewriteBundleArtifact(bundle, 'roles.sql', content);
    const rolesFile = bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/roles.sql`);
    const manifestFile = bundleFile(bundle.directory, BUNDLE_PATHS.manifest);
    const manifestBefore = fs.readFileSync(manifestFile);
    const boundaries = mockDisposableBoundaries();
    const psql = vi.spyOn(disposableStack, 'runDisposablePsql')
      .mockImplementation((_identity, options) => (
        options.command?.includes('pg_parameter_acl')
          ? JSON.stringify({
            roles: EXPECTED_ROLE_COMPATIBILITY_TARGET_ROLES,
            knownParameterAclRowCount: 0,
          })
          : ''
      ));

    const result = await runRestoreVerification({
      repositoryRoot: path.resolve(__dirname, '../../../..'),
      bundleDirectory: bundle.directory,
    });

    expect(result.roleParameterAclCompatibility).toBe('NORMALIZED_KNOWN_PLATFORM_ACL');
    const schemaReplay = psql.mock.calls.find((call) => (call[1].files ?? []).length === 3);
    expect(schemaReplay?.[1].files).toEqual([
      '/tmp/recovery/roles.normalized.sql',
      '/tmp/recovery/schema.sql',
      '/tmp/recovery/migrations-schema.sql',
    ]);
    const staged = boundaries.copied.mock.calls
      .find((call) => call[2] === '/tmp/recovery/roles.normalized.sql');
    expect(staged).toBeDefined();
    const normalizedHostFile = (staged as unknown as [unknown, string, string])[1];
    // The normalized artifact is verifier-owned and lives only inside the disposable workdir.
    expect(normalizedHostFile.includes('capstone-recovery-')).toBe(true);
    expect(fs.readFileSync(normalizedHostFile, 'utf8'))
      .toBe(planRoleParameterAclCompatibility(content.toString('utf8')).normalizedRolesSql);
    expect(fs.readFileSync(rolesFile).equals(content)).toBe(true);
    expect(fs.readFileSync(manifestFile).equals(manifestBefore)).toBe(true);
    expect(formatRestoreSummary(result, assertBundlePreserved(bundle.directory)))
      .toContain('ROLE_PLATFORM_ACL_COMPATIBILITY = NORMALIZED_KNOWN_PLATFORM_ACL');
  });

  it.each([
    ['an unsupported parameter ACL hidden behind bare CR',
      ['-- heading\rGRANT ALTER SYSTEM ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['a session authorization switch hidden behind bare CR',
      ['-- heading\rSET SESSION AUTHORIZATION "postgres";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED'],
    ['an ACL after a bare-CR comment and ordinary literal carrying a fake canonical grant',
      ["-- heading\rALTER ROLE \"capstone_reporting\" SET \"note\" TO ';",
        KNOWN_PLATFORM_GRANT,
        "-- literal\r'; GRANT ALTER SYSTEM ON PARAMETER \"log_min_messages\" TO \"supabase_realtime_admin\";"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['an ACL after a bare-CR comment and escape literal carrying a fake canonical grant',
      ["-- heading\rALTER ROLE \"capstone_reporting\" SET \"note\" TO E';",
        KNOWN_PLATFORM_GRANT,
        "-- literal\r'; GRANT ALTER SYSTEM ON PARAMETER \"log_min_messages\" TO \"supabase_realtime_admin\";"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['an ACL after a bare-CR comment and dollar literal carrying a fake canonical grant',
      ['-- heading\rALTER ROLE "capstone_reporting" SET "note" TO $body$;',
        KNOWN_PLATFORM_GRANT,
        '-- literal\r$body$; GRANT ALTER SYSTEM ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['an unterminated literal opened after a bare-CR comment carrying a fake canonical grant',
      ["-- heading\rALTER ROLE \"capstone_reporting\" SET \"note\" TO ';", KNOWN_PLATFORM_GRANT],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_UNTERMINATED_LITERAL'],
    ['a real parameter ACL hidden behind nested block comments',
      ["/* outer /* inner */ ' */",
        'GRANT SET ON PARAMETER "statement_timeout"',
        '  TO "supabase_realtime_admin";',
        "/* ' */"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['a real parameter ACL between valid escape-string literals',
      ["ALTER ROLE \"capstone_reporting\" SET \"note_a\" TO E'can\\'t';",
        'GRANT SET ON PARAMETER "wal_level" TO "postgres";',
        "ALTER ROLE \"capstone_reporting\" SET \"note_b\" TO E'can\\'t';"],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['a real parameter ACL beside dollar-quoted role data',
      ['ALTER ROLE "capstone_reporting" SET "note_c" TO $$one; two;$$;',
        'GRANT SET ON PARAMETER "wal_level" TO "postgres";'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_STATEMENT_UNSUPPORTED'],
    ['a grantor switch split across physical lines',
      ['SET SESSION', 'AUTHORIZATION "postgres";', KNOWN_PLATFORM_GRANT],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED'],
    ['a grantor switch separated by a block comment',
      ['SET SESSION', '/* provider */', 'AUTHORIZATION "postgres";', KNOWN_PLATFORM_GRANT],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_GRANTOR_SWITCH_UNSUPPORTED'],
    ['an unterminated dollar-quoted role setting',
      ['ALTER ROLE "capstone_reporting" SET "note_d" TO $body$one;'],
      'ROLE_PLATFORM_ACL_COMPATIBILITY_UNTERMINATED_LITERAL'],
  ])('refuses %s before Docker, staging or replay', async (_label, statements, expectedCode) => {
    const bundle = buildBundle();
    const content = Buffer.from(roleDumpFixture(statements), 'utf8');
    rewriteBundleArtifact(bundle, 'roles.sql', content);
    const manifestFile = bundleFile(bundle.directory, BUNDLE_PATHS.manifest);
    const manifestBefore = fs.readFileSync(manifestFile);
    const boundaries = mockDisposableBoundaries();
    const psql = vi.spyOn(disposableStack, 'runDisposablePsql').mockReturnValue('');

    const result = await runRestoreVerification({
      repositoryRoot: path.resolve(__dirname, '../../../..'),
      bundleDirectory: bundle.directory,
    });

    expect(result.classification).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED');
    expect(result.roleParameterAclCompatibility).toBe('NOT_RUN');
    expect(result.findings).toEqual([expectedCode]);
    expect(boundaries.network).not.toHaveBeenCalled();
    expect(boundaries.start).not.toHaveBeenCalled();
    expect(boundaries.staging).not.toHaveBeenCalled();
    expect(boundaries.copied).not.toHaveBeenCalled();
    expect(psql).not.toHaveBeenCalled();
    expect(fs.readFileSync(bundleFile(bundle.directory, `${BUNDLE_PATHS.database}/roles.sql`))
      .equals(content)).toBe(true);
    expect(fs.readFileSync(manifestFile).equals(manifestBefore)).toBe(true);
  });

  it('stays distinguishable from an ordinary schema.sql psql failure', () => {
    expect(classifyRestoreFailure(
      new RecoveryGuardError('ROLE_PLATFORM_ACL_COMPATIBILITY_DUPLICATE'),
    )).toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED');
    expect(classifyRestoreFailure(new RecoveryGuardError('RESTORE_SCHEMA_SQL_FAILED')))
      .toBe('RESTORE_SCHEMA_FAILED');
    // The role phase stops earlier than schema replay, so it outranks it.
    expect(resolveClassification(['RESTORE_SCHEMA_FAILED', 'ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED']))
      .toBe('ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED');
    expect(resolveClassification(['ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED', 'CLEANUP_FAILED']))
      .toBe('CLEANUP_FAILED');
    expect(resolveClassification(['ROLE_PLATFORM_ACL_COMPATIBILITY_FAILED']))
      .not.toBe('ZERO_COST_RECOVERY_REHEARSAL_VERIFIED');
  });
});

describe('synthetic platform parameter ACL source isolation', () => {
  const repositoryRoot = path.resolve(__dirname, '../../../..');

  /** A capture whose caller claims a disposable synthetic source in every caller-controlled way. */
  function syntheticCapture(input: {
    targetWorkdir: string;
    sourceProjectRef: string;
    outputDirectory: string;
    syntheticSource: disposableStack.DisposableStackIdentity;
  }) {
    return captureRecoveryBackup({
      repositoryRoot,
      target: { kind: 'local', workdir: input.targetWorkdir },
      sourceKind: 'disposable-local-synthetic',
      sourceProjectRef: input.sourceProjectRef,
      environmentLabel: 'disposable-local-synthetic',
      outputDirectory: input.outputDirectory,
      storageApiUrl: 'http://127.0.0.1:54321',
      storageServiceKey: 'synthetic-service-key',
      scratchDirectory: path.join(input.targetWorkdir, 'scratch'),
      syntheticPlatformParameterAclSource: input.syntheticSource,
    });
  }

  function ownedDisposableSource(): disposableStack.DisposableStackIdentity {
    const identity = createDisposableStackIdentity({
      repositoryRoot,
      mode: 'bare-restore-target',
      portBase: 54_960,
      postgresMajorVersion: 17,
      tag: 'unit',
    });
    temporaryDirectories.push(identity.workdir);
    return identity;
  }

  it('refuses an ordinary operator Local stack that only claims the synthetic source kind', async () => {
    // A caller-constructed identity over an ordinary local workdir: right shape, no ownership.
    const workdir = temporaryDirectory('capstone-operator-local-');
    const projectId = 'capstone-pp1-recovery-source-abcdef12';
    const outputDirectory = temporaryDirectory();
    await expect(syntheticCapture({
      targetWorkdir: workdir,
      sourceProjectRef: projectId,
      outputDirectory,
      syntheticSource: {
        projectId,
        networkName: `${projectId}-loopback`,
        portBase: 54_820,
        workdir,
        databaseContainer: `supabase_db_${projectId}`,
      },
    })).rejects.toThrowError('SYNTHETIC_PLATFORM_PARAMETER_ACL_SOURCE_NOT_OWNED');
    // Refused before the bundle directory, any dump, or any checksum exists.
    expect(fs.readdirSync(outputDirectory)).toEqual([]);
  });

  it('refuses a capture of some other workdir than the owned disposable source', async () => {
    const identity = ownedDisposableSource();
    const outputDirectory = temporaryDirectory();
    await expect(syntheticCapture({
      targetWorkdir: temporaryDirectory('capstone-operator-local-'),
      sourceProjectRef: identity.projectId,
      outputDirectory,
      syntheticSource: identity,
    })).rejects.toThrowError('SYNTHETIC_PLATFORM_PARAMETER_ACL_SOURCE_NOT_OWNED');
    expect(fs.readdirSync(outputDirectory)).toEqual([]);
  });

  it('refuses a capture recorded under a different project identity', async () => {
    const identity = ownedDisposableSource();
    const outputDirectory = temporaryDirectory();
    await expect(syntheticCapture({
      targetWorkdir: identity.workdir,
      sourceProjectRef: 'capstone-pp1-recovery-source-abcdef12',
      outputDirectory,
      syntheticSource: identity,
    })).rejects.toThrowError('SYNTHETIC_PLATFORM_PARAMETER_ACL_SOURCE_NOT_OWNED');
    expect(fs.readdirSync(outputDirectory)).toEqual([]);
  });

  it('refuses when the running source database container is not verifier-owned', async () => {
    const identity = ownedDisposableSource();
    const outputDirectory = temporaryDirectory();
    const containerOwnership = vi.spyOn(disposableStack, 'assertDatabaseContainerOwned')
      .mockImplementation(() => {
        throw new Error('DISPOSABLE_DATABASE_OWNERSHIP_UNPROVEN');
      });
    await expect(syntheticCapture({
      targetWorkdir: identity.workdir,
      sourceProjectRef: identity.projectId,
      outputDirectory,
      syntheticSource: identity,
    })).rejects.toThrowError('SYNTHETIC_PLATFORM_PARAMETER_ACL_SOURCE_NOT_OWNED');
    expect(containerOwnership).toHaveBeenCalledWith(identity);
    expect(fs.readdirSync(outputDirectory)).toEqual([]);
  });
});

describe('Storage and failure classifications', () => {
  it('detects missing, extra, changed and wrong-bucket objects without returning keys', () => {
    const original = objectRecord('project-drafts-private', 'private/person-key.png', Buffer.from('one'));
    const changed = objectRecord('project-drafts-private', original.key, Buffer.from('two'));
    const extra = objectRecord('project-drafts-private', 'private/extra.png', Buffer.from('extra'));
    const differences = compareStorageObjects([original], [changed, extra]);
    expect(differences.map((difference) => difference.kind).sort()).toEqual(['CHANGED_OBJECT', 'EXTRA_OBJECT']);
    expect(JSON.stringify(differences)).not.toContain(original.key);
    expect(compareStorageObjects([original], [])).toMatchObject([{ kind: 'MISSING_OBJECT' }]);
    expect(compareStorageObjects([original], [{ ...original, bucket: 'project-public-assets' }]))
      .toMatchObject([{ kind: 'WRONG_BUCKET' }]);
    expect(compareStorageObjects([original], [{ ...original, contentType: null }]))
      .toMatchObject([{ kind: 'CHANGED_CONTENT_TYPE' }]);
  });

  it('detects bucket visibility and configuration drift', () => {
    const restored = bucketConfigurations.map((bucket) => ({ ...bucket }));
    restored[0] = { ...restored[0], public: !restored[0].public };
    expect(compareBucketConfiguration(bucketConfigurations, restored))
      .toContainEqual({ bucket: restored[0].id, field: 'public' });
    restored[1] = { ...restored[1], allowedMimeTypes: ['application/pdf'] };
    expect(compareBucketConfiguration(bucketConfigurations, restored))
      .toContainEqual({ bucket: restored[1].id, field: 'allowedMimeTypes' });
  });

  it('fails closed for SQL restore, database, Gate 4, Storage and cleanup failures', () => {
    expect(resolveClassification(['RESTORE_FAILED'])).toBe('RESTORE_FAILED');
    expect(resolveClassification(['RESTORE_SCHEMA_FAILED'])).toBe('RESTORE_SCHEMA_FAILED');
    expect(resolveClassification(['RESTORE_DATA_FAILED'])).toBe('RESTORE_DATA_FAILED');
    expect(resolveClassification(['MANAGED_AUTH_COMPATIBILITY_FAILED']))
      .toBe('MANAGED_AUTH_COMPATIBILITY_FAILED');
    expect(resolveClassification(['RESTORE_INTEGRITY_DRIFT'])).toBe('RESTORE_INTEGRITY_DRIFT');
    expect(resolveClassification(['MANAGED_SCHEMA_CUSTOMIZATION_DRIFT']))
      .toBe('MANAGED_SCHEMA_CUSTOMIZATION_DRIFT');
    expect(resolveClassification(['GATE4_DRIFT'])).toBe('GATE4_DRIFT');
    expect(resolveClassification(['STORAGE_RESTORE_DRIFT'])).toBe('STORAGE_RESTORE_DRIFT');
    expect(resolveClassification(['CLEANUP_FAILED'])).toBe('CLEANUP_FAILED');
    expect(resolveClassification([])).toBe('ZERO_COST_RECOVERY_REHEARSAL_VERIFIED');
  });

  it('rejects unsafe Storage keys', () => {
    expect(() => assertSafeObjectKey('../escape')).toThrowError('UNSAFE_STORAGE_OBJECT_KEY');
    expect(() => assertSafeObjectKey('/absolute')).toThrowError('UNSAFE_STORAGE_OBJECT_KEY');
    expect(() => assertSafeObjectKey('private\\windows-path')).toThrowError('UNSAFE_STORAGE_OBJECT_KEY');
  });
});

describe('disposable ownership and safe summaries', () => {
  it('builds a bare PostgreSQL 17 target without canonical seed or bucket declarations', () => {
    const baseConfig = [
      'project_id = "canonical"',
      '[api]', 'port = 54321',
      '[db]', 'port = 54322', 'shadow_port = 54320', 'major_version = 15',
      'seed = { sql_paths = ["./seed.sql"] }',
      '[studio]', 'port = 54323',
      '[inbucket]', 'port = 54324', 'smtp_port = 54325', 'pop3_port = 54326',
      '[storage.buckets.project-drafts-private]', 'public = false',
    ].join('\n');
    const configured = buildDisposableSupabaseConfig({
      baseConfig,
      projectId: 'capstone-pp1-recovery-target-abcdef12',
      portBase: 54_940,
      postgresMajorVersion: 17,
      mode: 'bare-restore-target',
    });
    expect(configured).toContain('major_version = 17');
    expect(configured).not.toContain('seed =');
    expect(configured).not.toContain('[storage.buckets.');
  });

  it('creates a unique marked temporary workdir and never targets the canonical Local project id', () => {
    const identity = createDisposableStackIdentity({
      repositoryRoot: path.resolve(__dirname, '../../../..'),
      mode: 'bare-restore-target',
      portBase: 54_940,
      postgresMajorVersion: 17,
      tag: 'target',
    });
    temporaryDirectories.push(identity.workdir);
    expect(identity.projectId).toMatch(/^capstone-pp1-recovery-target-[a-f0-9]{8}$/);
    expect(identity.projectId).not.toBe('capstone-impact-platform');
    expect(fs.readFileSync(path.join(identity.workdir, '.capstone-recovery-owner'), 'utf8').trim())
      .toBe(identity.projectId);
  });

  it('contains no canonical reset command or direct Storage metadata write path', () => {
    const repositoryRoot = path.resolve(__dirname, '../../../..');
    const recoverySources = [
      'apps/admin-cms/src/recovery/disposableSupabaseStack.ts',
      'apps/admin-cms/src/recovery/storageTransfer.ts',
      'apps/admin-cms/src/scripts/rehearseZeroCostRecovery.ts',
    ].map((file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8')).join('\n');
    expect(recoverySources).not.toMatch(/['"]db['"]\s*,\s*['"]reset['"]/);
    expect(recoverySources).not.toMatch(/['"]reset['"]\s*,\s*['"]--workdir['"]/);
    expect(recoverySources).not.toMatch(/insert\s+into\s+storage\.objects/i);
    expect(recoverySources).not.toMatch(/update\s+storage\.objects/i);
  });

  it('keeps normal and rejected-bundle summaries free of private values', () => {
    const result = {
      classification: 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED',
      findings: [],
      restoreStartedAt: '2026-09-01T00:00:00.000Z',
      restoreCompletedAt: '2026-09-01T00:00:01.000Z',
      verificationCompletedAt: '2026-09-01T00:00:02.000Z',
      backupAgeAtRestoreStartMs: 0,
      restoreDurationMs: 1_000,
      verificationDurationMs: 2_000,
      sourcePostgresMajorVersion: 15,
      restoredPostgresMajorVersion: 17,
      migrationCount: 48,
      latestMigration: '20260831090000',
      publicApplicationTables: 37,
      executionControlTables: 3,
      storageObjectCount: 3,
      databaseIntegrityMatch: true,
      storageIntegrityMatch: true,
      assistiveCostFenceMatch: true,
      sourceAuthUserCount: 1,
      restoredAuthUserCount: 1,
      authCountMatch: true,
      restoredAuthOrphanIdentityCount: 0,
      managedAuthCustomizationCount: 2,
      expectedManagedAuthCustomizationCount: 2,
      managedStorageCustomizationCount: 0,
      expectedManagedStorageCustomizationCount: 0,
      managedSchemaCustomizationsMatch: true,
      managedAuthCompatibility: 'ALIGNED_KNOWN_DELTA',
      roleParameterAclCompatibility: 'NORMALIZED_KNOWN_PLATFORM_ACL',
      tableGrantPortabilityCompatibility: 'REVOKED_KNOWN_TARGET_DEFAULT_ACL_OVERGRANTS',
      tableGrantPortabilityRevokeCount: 4,
      legacyUnalignedDataReplayFailed: true,
      legacyUnnormalizedRoleReplayFailed: true,
      legacyUnnormalizedRoleReplaySqlState: '42501',
      managedAuthBehaviorVerified: true,
      bucketSummaries: ['project-drafts-private: 1 objects, 12 bytes, root abcdef123456'],
      gate4: null,
      applicationSmoke: {
        attempted: false,
        healthStatus: null,
        readinessStatus: null,
        readinessClassification: null,
        loginStatus: null,
        markerPresent: false,
        stagingIdentityClaimed: false,
      },
      residueAbsent: true,
    } satisfies RestoreVerificationResult;
    const output = formatRestoreSummary(result, true);
    expect(output).not.toContain('private/person-key.png');
    expect(output).not.toContain('recovery-rehearsal@synthetic.invalid');
    expect(output).not.toContain('sb_secret_');
    expect(output).not.toContain('postgresql://');

    const sensitiveToken = `SECRETTOKEN_${randomBytes(16).toString('hex').replace(/[0-9]/g, 'X').toUpperCase()}`;
    let rejected: unknown;
    try {
      deriveManagedAuthCopyRequirements(`${hostedAheadAuthDataSql}\n${sensitiveToken} malformed;`);
    } catch (error) {
      rejected = error;
    }
    expect(rejected instanceof RecoveryGuardError).toBe(true);
    const failure = rejected as RecoveryGuardError;
    // Boolean assertions cannot print the synthetic token on regression failures.
    expect(failure.code.includes(sensitiveToken)).toBe(false);
    expect(failure.message.includes(sensitiveToken)).toBe(false);
    expect(failure.code === 'MANAGED_AUTH_COMPATIBILITY_DATA_DUMP_STATEMENT_UNSUPPORTED').toBe(true);
    const failedSummary = formatRestoreSummary({
      ...result,
      classification: classifyRestoreFailure(failure),
      findings: [failure.message],
    }, true);
    expect(failedSummary.includes(sensitiveToken)).toBe(false);
    expect(failedSummary).toContain('FINDING = MANAGED_AUTH_COMPATIBILITY_DATA_DUMP_STATEMENT_UNSUPPORTED');
  });

  it('requires the exact fail-closed readiness contract in application smoke', () => {
    const expected: ApplicationSmokeResult = {
      attempted: true,
      healthStatus: 200,
      readinessStatus: 503,
      readinessClassification: 'CONFIGURATION_NOT_READY',
      loginStatus: 200,
      markerPresent: true,
      stagingIdentityClaimed: false,
    };
    expect(applicationSmokeMatchesRecoveryContract(expected)).toBe(true);
    expect(applicationSmokeMatchesRecoveryContract({
      ...expected,
      readinessStatus: 500,
      readinessClassification: null,
    })).toBe(false);
  });

  it('uses only explicit fail-closed classifications', () => {
    const error = new RecoveryGuardError('RESTORE_DATA_SQL_FAILED');
    expect(error.code).toBe('RESTORE_DATA_SQL_FAILED');
    expect(classifyRestoreFailure(new RecoveryGuardError('RESTORE_SCHEMA_SQL_FAILED')))
      .toBe('RESTORE_SCHEMA_FAILED');
    expect(classifyRestoreFailure(error)).toBe('RESTORE_DATA_FAILED');
    expect(classifyRestoreFailure(
      new RecoveryGuardError('MANAGED_AUTH_COMPATIBILITY_UNKNOWN_DRIFT'),
    )).toBe('MANAGED_AUTH_COMPATIBILITY_FAILED');
    expect(resolveClassification(['RESTORE_FAILED'])).not.toBe('ZERO_COST_RECOVERY_REHEARSAL_VERIFIED');
  });
});
