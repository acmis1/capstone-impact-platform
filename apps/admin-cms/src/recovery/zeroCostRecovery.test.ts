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
