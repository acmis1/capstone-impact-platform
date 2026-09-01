import path from 'node:path';

/**
 * Zero-cost hosted-origin recovery rehearsal contract.
 *
 * The source of a real capture is the active hosted Supabase Free staging project. The restore
 * target is always a disposable local/self-hosted Supabase stack owned by the verifier. Nothing in
 * this contract depends on Supabase Pro, Branching, PITR, paid backup storage, or any other
 * billable provider feature: the bundle is an operator-created logical backup plus separately
 * transferred Storage object bytes.
 *
 * Because the restore target is local, a passing rehearsal is never managed-hosted recovery
 * evidence. See RECOVERY_EVIDENCE_LABEL and the wording rules in
 * docs/operations/zero-cost-recovery-rehearsal.md.
 */

export const RECOVERY_BUNDLE_FORMAT = 'zero-cost-hosted-origin-recovery/v2' as const;

/** Truthful label for this evidence. Never relabel it as managed-hosted PITR or hosted RTO. */
export const RECOVERY_EVIDENCE_LABEL = 'ZERO_COST_HOSTED_ORIGIN_RECOVERY_REHEARSAL' as const;

/** The only hosted project a capture may ever read from. */
export const APPROVED_HOSTED_SOURCE_PROJECT_REF = 'sqkpceeltukbzxpsvinb';
export const APPROVED_HOSTED_SOURCE_PROJECT_NAME = 'capstone-admin-cms-staging-v2-2026';

/**
 * Refs that are known and must be named in the refusal so an operator cannot mistake a guard
 * failure for a transient error. A project name is never sufficient authority; only the ref is.
 */
export const REFUSED_SOURCE_PROJECT_REFS: Readonly<Record<string, string>> = Object.freeze({
  fewcbklmbgzglfgedtvt: 'HISTORICAL_STAGING_PROJECT_REFUSED',
  bpnmrgmzgbisvykppuwp: 'PROTOTYPE_RECOVERY_PROJECT_REFUSED',
});

export const CANONICAL_STORAGE_BUCKETS = [
  'project-drafts-private',
  'project-public-assets',
  'public-feeds',
] as const;

export type CanonicalStorageBucket = (typeof CANONICAL_STORAGE_BUCKETS)[number];

/** Buckets whose object keys must never reach an ordinary terminal summary. */
export const PRIVATE_STORAGE_BUCKETS: readonly string[] = ['project-drafts-private'];

/** Ordered logical-backup artifacts. The restore applies them in exactly this order. */
export const DATABASE_BACKUP_ARTIFACTS = [
  'roles.sql',
  'schema.sql',
  'migrations-schema.sql',
  'data.sql',
  'migrations-data.sql',
] as const;

export type DatabaseBackupArtifact = (typeof DATABASE_BACKUP_ARTIFACTS)[number];

export const EXECUTION_CONTROL_SCHEMA = 'assistive_execution_control';

/** The cost fence that recovery must never "repair" by dropping reservation history. */
export const EXPECTED_LAUNCH_BUDGET_GUARD = Object.freeze({
  environment: 'staging',
  launchLimit: 40,
  windowDays: 31,
  maxActiveExecutions: 1,
});

export type RecoveryClassification =
  | 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED'
  | 'SOURCE_CAPTURE_INCOMPLETE'
  | 'RECOVERY_BUNDLE_INVALID'
  | 'RESTORE_FAILED'
  | 'RESTORE_INTEGRITY_DRIFT'
  | 'MANAGED_SCHEMA_CUSTOMIZATION_DRIFT'
  | 'GATE4_DRIFT'
  | 'STORAGE_RESTORE_DRIFT'
  | 'CLEANUP_FAILED';

/**
 * Only a run with no findings at all may be reported as verified. Ordering is by how early the
 * evidence stopped being trustworthy, so a cleanup or restore failure outranks a content drift.
 */
export function resolveClassification(
  findings: readonly RecoveryClassification[],
): RecoveryClassification {
  const severity: RecoveryClassification[] = [
    'CLEANUP_FAILED',
    'RESTORE_FAILED',
    'RECOVERY_BUNDLE_INVALID',
    'SOURCE_CAPTURE_INCOMPLETE',
    'GATE4_DRIFT',
    'MANAGED_SCHEMA_CUSTOMIZATION_DRIFT',
    'RESTORE_INTEGRITY_DRIFT',
    'STORAGE_RESTORE_DRIFT',
  ];
  for (const candidate of severity) {
    if (findings.includes(candidate)) return candidate;
  }
  return 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED';
}

export class RecoveryGuardError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'RecoveryGuardError';
  }
}

function isWellFormedProjectRef(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{20}$/.test(value);
}

export interface HostedCaptureTargetInput {
  /** Ref the operator typed on the command line. */
  requestedProjectRef: unknown;
  /** Ref the Supabase CLI itself records for the linked project. */
  linkedProjectRef: unknown;
}

/**
 * Fails closed before any hosted network capture. Both the operator explicit request and the CLI
 * own linked-project metadata must be exactly the approved staging ref. A mismatch is never
 * resolved by relinking: the operator must reconcile the workspace themselves.
 */
export function assertApprovedHostedCaptureTarget(input: HostedCaptureTargetInput): string {
  const { requestedProjectRef, linkedProjectRef } = input;
  if (linkedProjectRef === undefined || linkedProjectRef === null || linkedProjectRef === '') {
    throw new RecoveryGuardError('LINKED_PROJECT_REF_MISSING');
  }
  if (!isWellFormedProjectRef(linkedProjectRef)) {
    throw new RecoveryGuardError('LINKED_PROJECT_REF_MALFORMED');
  }
  if (requestedProjectRef === undefined || requestedProjectRef === null || requestedProjectRef === '') {
    throw new RecoveryGuardError('REQUESTED_PROJECT_REF_MISSING');
  }
  if (!isWellFormedProjectRef(requestedProjectRef)) {
    throw new RecoveryGuardError('REQUESTED_PROJECT_REF_MALFORMED');
  }
  for (const ref of [requestedProjectRef, linkedProjectRef]) {
    const refusal = REFUSED_SOURCE_PROJECT_REFS[ref];
    if (refusal) throw new RecoveryGuardError(refusal);
  }
  if (requestedProjectRef !== APPROVED_HOSTED_SOURCE_PROJECT_REF) {
    throw new RecoveryGuardError('REQUESTED_PROJECT_REF_NOT_APPROVED');
  }
  if (linkedProjectRef !== APPROVED_HOSTED_SOURCE_PROJECT_REF) {
    throw new RecoveryGuardError('LINKED_PROJECT_REF_NOT_APPROVED');
  }
  return APPROVED_HOSTED_SOURCE_PROJECT_REF;
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isInsideDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(normalizeForComparison(parent), normalizeForComparison(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export type BackupDirectoryRejection =
  | 'BACKUP_DIRECTORY_NOT_ABSOLUTE'
  | 'BACKUP_DIRECTORY_INSIDE_REPOSITORY'
  | 'BACKUP_DIRECTORY_INSIDE_GIT_WORKTREE'
  | 'BACKUP_DIRECTORY_SYMLINK'
  | 'BACKUP_DIRECTORY_CONTAINS_TRACKED_FILES'
  | 'BACKUP_DIRECTORY_NOT_EMPTY';

export interface BackupDirectoryInput {
  directory: string;
  repositoryRoot: string;
  /**
   * `git rev-parse --show-toplevel` evaluated from the nearest existing ancestor of `directory`,
   * or null when that ancestor is not inside any Git working tree. This catches worktrees, nested
   * clones, and `.git` directories without enumerating them by hand.
   */
  gitToplevel: string | null;
  /** Tracked paths reported under `directory`; any hit means the path is repository-managed. */
  trackedFileCount: number;
  /** Entries already present in `directory`; zero when it does not exist yet. */
  existingEntryCount: number;
}

export type BackupDirectoryDecision =
  | { ok: true; directory: string }
  | { ok: false; reason: BackupDirectoryRejection };

/**
 * The recovery bundle carries private participant and staff data plus role definitions. It must
 * never be written anywhere Git could stage it, so the guard refuses the repository, any Git
 * working tree, and any path that already holds tracked files.
 */
export function classifyBackupDirectory(input: BackupDirectoryInput): BackupDirectoryDecision {
  const { directory, repositoryRoot, gitToplevel, trackedFileCount, existingEntryCount } = input;
  if (!directory || !path.isAbsolute(directory)) {
    return { ok: false, reason: 'BACKUP_DIRECTORY_NOT_ABSOLUTE' };
  }
  if (isInsideDirectory(repositoryRoot, directory)) {
    return { ok: false, reason: 'BACKUP_DIRECTORY_INSIDE_REPOSITORY' };
  }
  if (gitToplevel !== null) {
    return { ok: false, reason: 'BACKUP_DIRECTORY_INSIDE_GIT_WORKTREE' };
  }
  if (trackedFileCount > 0) {
    return { ok: false, reason: 'BACKUP_DIRECTORY_CONTAINS_TRACKED_FILES' };
  }
  if (existingEntryCount > 0) {
    return { ok: false, reason: 'BACKUP_DIRECTORY_NOT_EMPTY' };
  }
  return { ok: true, directory: path.resolve(directory) };
}

/**
 * Object keys can identify participants and staff. Summaries report counts and checksum roots, so
 * this redaction keeps a bucket identifiable without ever printing what is inside it.
 */
export function summarizeBucketForTerminal(input: {
  bucket: string;
  objectCount: number;
  totalBytes: number;
}): string {
  return `${input.bucket}: ${input.objectCount} objects, ${input.totalBytes} bytes`;
}
