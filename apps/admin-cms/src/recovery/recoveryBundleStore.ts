import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  SHA256_PATTERN,
  summarizeBuckets,
  validateRecoveryBundleManifest,
  type RecoveryBundleManifest,
  type StorageObjectRecord,
  type TableDataEvidence,
} from './recoveryBundle';
import {
  classifyBackupDirectory,
  CANONICAL_STORAGE_BUCKETS,
  DATABASE_BACKUP_ARTIFACTS,
  isInsideDirectory,
  RecoveryGuardError,
  type BackupDirectoryDecision,
} from './zeroCostRecoveryContract';
import { assertSafeObjectKey, type CapturedStorageObject } from './storageTransfer';

/**
 * Bundle layout on operator-selected disk.
 *
 * Object bytes are stored content-addressed rather than under their original key so a hostile or
 * merely awkward object name can never steer a write during restore, and identical bytes are
 * stored once. The mapping back to bucket and key lives only in the private manifest.
 */

export const BUNDLE_PATHS = {
  manifest: 'backup-manifest.json',
  database: 'database',
  privateObjectManifest: 'storage/private-object-manifest.json',
  objects: 'storage/objects',
  dataEvidence: 'evidence/data-evidence.json',
  gate4Evidence: 'evidence/gate4-source-evidence.json',
} as const;

export const PRIVATE_OBJECT_MANIFEST_FORMAT = 'zero-cost-recovery-private-objects/v1' as const;
const MAX_SAFE_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PRIVATE_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_DATA_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_GATE4_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_STORAGE_OBJECT_BYTES = 256 * 1024 * 1024;

export interface PrivateObjectManifest {
  formatVersion: typeof PRIVATE_OBJECT_MANIFEST_FORMAT;
  classification: 'PRIVATE_RECOVERY_EVIDENCE_NEVER_COMMIT';
  objects: StorageObjectRecord[];
}

function nearestExistingAncestor(directory: string): string {
  let current = path.resolve(directory);
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function gitToplevelOf(directory: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function trackedFileCountUnder(directory: string): number {
  try {
    const output = execFileSync('git', ['ls-files', '--', directory], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    });
    return output.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Resolves and proves an operator-selected backup directory is outside every Git working tree.
 * The bundle holds private data; it must never become stageable.
 */
export function resolveOperatorBackupDirectory(
  directory: string,
  repositoryRoot: string,
): BackupDirectoryDecision {
  if (!directory || !path.isAbsolute(directory)) {
    return { ok: false, reason: 'BACKUP_DIRECTORY_NOT_ABSOLUTE' };
  }
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    return { ok: false, reason: 'BACKUP_DIRECTORY_SYMLINK' };
  }
  const probe = nearestExistingAncestor(resolved);
  const physicalProbe = fs.realpathSync.native(probe);
  return classifyBackupDirectory({
    directory: resolved,
    repositoryRoot,
    gitToplevel: gitToplevelOf(physicalProbe),
    trackedFileCount: fs.existsSync(resolved) ? trackedFileCountUnder(resolved) : 0,
    existingEntryCount: fs.existsSync(resolved) ? fs.readdirSync(resolved).length : 0,
  });
}

export function assertOperatorBackupDirectory(directory: string, repositoryRoot: string): string {
  const decision = resolveOperatorBackupDirectory(directory, repositoryRoot);
  if (!decision.ok) throw new RecoveryGuardError(decision.reason);
  return decision.directory;
}

/** Refuses to consume private bundle material from any repository or Git worktree. */
export function assertRecoveryBundleDirectory(directory: string, repositoryRoot: string): string {
  if (!directory || !path.isAbsolute(directory)) {
    throw new RecoveryGuardError('BACKUP_DIRECTORY_NOT_ABSOLUTE');
  }
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved)) throw new RecoveryGuardError('RECOVERY_BUNDLE_DIRECTORY_MISSING');
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_DIRECTORY_INVALID');
  }
  const physical = fs.realpathSync.native(resolved);
  const physicalRepository = fs.realpathSync.native(repositoryRoot);
  if (isInsideDirectory(physicalRepository, physical)) {
    throw new RecoveryGuardError('BACKUP_DIRECTORY_INSIDE_REPOSITORY');
  }
  if (gitToplevelOf(physical) !== null) {
    throw new RecoveryGuardError('BACKUP_DIRECTORY_INSIDE_GIT_WORKTREE');
  }
  return physical;
}

export function bundleFile(bundleDirectory: string, relative: string): string {
  if (!relative
    || path.isAbsolute(relative)
    || relative.includes('\\')
    || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_PATH_UNSAFE');
  }
  const root = path.resolve(bundleDirectory);
  const target = path.resolve(root, ...relative.split('/'));
  const within = path.relative(root, target);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_PATH_UNSAFE');
  }
  return target;
}

export function writeJsonArtifact(bundleDirectory: string, relative: string, value: unknown): string {
  const target = bundleFile(bundleDirectory, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(target, serialized, { encoding: 'utf8', mode: 0o600 });
  return sha256(serialized);
}

export function sha256File(file: string): string {
  const descriptor = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

export function writeStorageObject(
  bundleDirectory: string,
  object: CapturedStorageObject,
): void {
  if (!SHA256_PATTERN.test(object.record.sha256)) throw new Error('STORAGE_OBJECT_CHECKSUM_INVALID');
  if (object.content.length !== object.record.bytes || sha256(object.content) !== object.record.sha256) {
    throw new Error('STORAGE_OBJECT_CONTENT_MISMATCH');
  }
  const directory = bundleFile(bundleDirectory, BUNDLE_PATHS.objects);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, object.record.sha256);
  if (!fs.existsSync(target)) fs.writeFileSync(target, object.content, { mode: 0o600 });
}

export function writeStorageObjects(
  bundleDirectory: string,
  objects: readonly CapturedStorageObject[],
): void {
  for (const object of objects) {
    writeStorageObject(bundleDirectory, object);
  }
}

export function readStorageObjectBlob(bundleDirectory: string, digest: string): Buffer {
  assertStorageObjectBlob(bundleDirectory, digest);
  return fs.readFileSync(path.join(bundleFile(bundleDirectory, BUNDLE_PATHS.objects), digest));
}

function assertStorageObjectBlob(
  bundleDirectory: string,
  digest: string,
  expectedBytes?: number,
): void {
  if (!SHA256_PATTERN.test(digest)) throw new Error('STORAGE_OBJECT_CHECKSUM_INVALID');
  const file = path.join(bundleFile(bundleDirectory, BUNDLE_PATHS.objects), digest);
  if (!fs.existsSync(file)) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_STORAGE_OBJECT_MISSING');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.size > MAX_STORAGE_OBJECT_BYTES
    || (expectedBytes !== undefined && stat.size !== expectedBytes)) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_STORAGE_OBJECT_INVALID');
  }
  if (sha256File(file) !== digest) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_STORAGE_OBJECT_CORRUPTED');
  }
}

export interface LoadedRecoveryBundle {
  directory: string;
  manifest: RecoveryBundleManifest;
  privateObjects: StorageObjectRecord[];
  dataEvidence: TableDataEvidence[];
  gate4Evidence: unknown;
}

function readJson(file: string, maxBytes: number): { value: unknown; digest: string } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_JSON_ARTIFACT_INVALID');
  }
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return { value: JSON.parse(raw) as unknown, digest: sha256(raw) };
  } catch {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_JSON_ARTIFACT_INVALID');
  }
}

/**
 * Reads a bundle and re-derives every recorded checksum. A tampered or truncated artifact fails
 * here, before any restore begins.
 */
export function loadRecoveryBundle(bundleDirectory: string): LoadedRecoveryBundle {
  const manifestFile = bundleFile(bundleDirectory, BUNDLE_PATHS.manifest);
  if (!fs.existsSync(manifestFile)) throw new RecoveryGuardError('RECOVERY_BUNDLE_MANIFEST_MISSING');
  const manifest = readJson(manifestFile, MAX_SAFE_MANIFEST_BYTES).value as RecoveryBundleManifest;
  const manifestErrors = validateRecoveryBundleManifest(manifest);
  if (manifestErrors.length > 0) {
    throw new RecoveryGuardError(`RECOVERY_BUNDLE_MANIFEST_INVALID:${manifestErrors[0]}`);
  }

  for (const artifact of DATABASE_BACKUP_ARTIFACTS) {
    const file = bundleFile(bundleDirectory, `${BUNDLE_PATHS.database}/${artifact}`);
    if (!fs.existsSync(file)) throw new RecoveryGuardError(`RECOVERY_BUNDLE_ARTIFACT_MISSING:${artifact}`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RecoveryGuardError(`RECOVERY_BUNDLE_ARTIFACT_INVALID:${artifact}`);
    }
    const recorded = manifest.database?.find((entry) => entry.artifact === artifact);
    if (!recorded) throw new RecoveryGuardError(`RECOVERY_BUNDLE_ARTIFACT_UNDECLARED:${artifact}`);
    if (stat.size !== recorded.bytes || sha256File(file) !== recorded.sha256) {
      throw new RecoveryGuardError(`RECOVERY_BUNDLE_ARTIFACT_CORRUPTED:${artifact}`);
    }
  }

  const privateManifestFile = bundleFile(bundleDirectory, BUNDLE_PATHS.privateObjectManifest);
  if (!fs.existsSync(privateManifestFile)) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_MANIFEST_MISSING');
  }
  const privateManifest = readJson(privateManifestFile, MAX_PRIVATE_MANIFEST_BYTES);
  if (privateManifest.digest !== manifest.storage?.privateObjectManifest?.sha256) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_MANIFEST_CORRUPTED');
  }
  const privateDocument = privateManifest.value as PrivateObjectManifest;
  if (privateDocument.formatVersion !== PRIVATE_OBJECT_MANIFEST_FORMAT
    || privateDocument.classification !== 'PRIVATE_RECOVERY_EVIDENCE_NEVER_COMMIT'
    || !Array.isArray(privateDocument.objects)) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_MANIFEST_INVALID');
  }
  const privateObjects = privateDocument.objects;
  if (privateObjects.length !== manifest.storage.privateObjectManifest.objectCount) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_COUNT_MISMATCH');
  }
  const identities = new Set<string>();
  const objectBlobs = new Map<string, number>();
  for (const record of privateObjects) {
    if (!record || typeof record !== 'object'
      || typeof record.bucket !== 'string'
      || typeof record.key !== 'string') {
      throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_RECORD_INVALID');
    }
    try {
      assertSafeObjectKey(record.key);
    } catch {
      throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_RECORD_INVALID');
    }
    if (!(CANONICAL_STORAGE_BUCKETS as readonly string[]).includes(record.bucket)
      || !Number.isSafeInteger(record.bytes)
      || record.bytes < 0
      || record.bytes > MAX_STORAGE_OBJECT_BYTES
      || !SHA256_PATTERN.test(record.sha256)
      || (record.contentType !== null
        && (typeof record.contentType !== 'string'
          || record.contentType.length === 0
          || record.contentType.length > 255
          || /[\r\n]/.test(record.contentType)))
      || (record.lastModified !== null
        && (typeof record.lastModified !== 'string'
          || record.lastModified.length > 128
          || Number.isNaN(Date.parse(record.lastModified))))
      || (record.version !== null
        && (typeof record.version !== 'string' || record.version.length > 512))) {
      throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_RECORD_INVALID');
    }
    const identity = `${record.bucket}\u0000${record.key}`;
    if (identities.has(identity)) throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_DUPLICATE');
    identities.add(identity);
    const recordedBytes = objectBlobs.get(record.sha256);
    if (recordedBytes !== undefined && recordedBytes !== record.bytes) {
      throw new RecoveryGuardError('RECOVERY_BUNDLE_PRIVATE_OBJECT_RECORD_INVALID');
    }
    objectBlobs.set(record.sha256, record.bytes);
  }
  for (const [digest, bytes] of objectBlobs) {
    assertStorageObjectBlob(bundleDirectory, digest, bytes);
  }
  const summarized = summarizeBuckets(
    manifest.storage.buckets.map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      public: bucket.public,
      fileSizeLimit: bucket.fileSizeLimit,
      allowedMimeTypes: bucket.allowedMimeTypes,
    })),
    privateObjects,
  );
  if (JSON.stringify(summarized) !== JSON.stringify(manifest.storage.buckets)) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_STORAGE_SUMMARY_MISMATCH');
  }

  const dataEvidenceFile = bundleFile(bundleDirectory, BUNDLE_PATHS.dataEvidence);
  if (!fs.existsSync(dataEvidenceFile)) throw new RecoveryGuardError('RECOVERY_BUNDLE_DATA_EVIDENCE_MISSING');
  const dataEvidence = readJson(dataEvidenceFile, MAX_DATA_EVIDENCE_BYTES);
  if (dataEvidence.digest !== manifest.dataEvidence?.sha256) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_DATA_EVIDENCE_CORRUPTED');
  }
  if (!Array.isArray(dataEvidence.value)
    || dataEvidence.value.length !== manifest.dataEvidence.tableCount) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_DATA_EVIDENCE_INVALID');
  }
  const tableIdentities = new Set<string>();
  for (const entry of dataEvidence.value) {
    if (!entry || typeof entry !== 'object') {
      throw new RecoveryGuardError('RECOVERY_BUNDLE_DATA_EVIDENCE_INVALID');
    }
    const table = entry as Record<string, unknown>;
    if (!['public', 'assistive_execution_control'].includes(String(table.schema ?? ''))
      || typeof table.table !== 'string'
      || !/^[a-z][a-z0-9_]{0,62}$/.test(table.table)
      || !Number.isSafeInteger(table.rowCount)
      || (table.rowCount as number) < 0
      || typeof table.checksum !== 'string'
      || !SHA256_PATTERN.test(table.checksum)) {
      throw new RecoveryGuardError('RECOVERY_BUNDLE_DATA_EVIDENCE_INVALID');
    }
    const identity = `${table.schema}.${table.table}`;
    if (tableIdentities.has(identity)) {
      throw new RecoveryGuardError('RECOVERY_BUNDLE_DATA_EVIDENCE_INVALID');
    }
    tableIdentities.add(identity);
  }

  const gate4File = bundleFile(bundleDirectory, BUNDLE_PATHS.gate4Evidence);
  if (!fs.existsSync(gate4File)) throw new RecoveryGuardError('RECOVERY_BUNDLE_GATE4_EVIDENCE_MISSING');
  const gate4 = readJson(gate4File, MAX_GATE4_EVIDENCE_BYTES);
  if (gate4.digest !== manifest.gate4Evidence?.sha256) {
    throw new RecoveryGuardError('RECOVERY_BUNDLE_GATE4_EVIDENCE_CORRUPTED');
  }

  return {
    directory: path.resolve(bundleDirectory),
    manifest,
    privateObjects,
    dataEvidence: dataEvidence.value as TableDataEvidence[],
    gate4Evidence: gate4.value,
  };
}
