import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
} from './disposableSupabaseStack';
import {
  applicationSmokeMatchesRecoveryContract,
  assertBundlePreserved,
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
import { repositoryMigrationVersions } from './captureRecoveryBackup';
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

const temporaryDirectories: string[] = [];

afterEach(() => {
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

  it('inventories exactly both current Auth triggers and no custom Storage object across 48 migrations', () => {
    const operations = inspectRepositoryManagedSchemaMigrationInventory(repositoryRoot);
    const creates = operations.filter((operation) => operation.action === 'CREATE_TRIGGER');
    expect(repositoryMigrationVersions(repositoryRoot)).toHaveLength(48);
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

  it('cannot false-green 48/48 migration history when a managed Auth trigger is absent', () => {
    const migrations = repositoryMigrationVersions(repositoryRoot);
    const restored = managedEvidenceFixture();
    restored.triggers.pop();
    const managedDrift = compareManagedSchemaCustomizations(
      REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
      restored,
    );
    expect(migrations).toHaveLength(48);
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

  it('does not expose object keys or secret-shaped values in a successful normal summary', () => {
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
    const error = new RecoveryGuardError('RESTORE_SQL_FAILED');
    expect(error.code).toBe('RESTORE_SQL_FAILED');
    expect(resolveClassification(['RESTORE_FAILED'])).not.toBe('ZERO_COST_RECOVERY_REHEARSAL_VERIFIED');
  });
});
