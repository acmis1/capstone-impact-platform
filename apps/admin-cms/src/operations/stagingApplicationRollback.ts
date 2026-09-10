import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseGate4Evidence,
  validateCurrentRepositoryGate4Contract,
} from '../deployment/gate4SchemaEvidence';
import {
  runHostedSmokeVerifier,
  type HostedSmokeReport,
} from '../deployment/hostedDeploymentSmokeVerifier';
import { assertVerifiedStagingRuntime, type StagingRuntimeEnvironment } from '../security/stagingRuntimeIdentity';
import { isValidMutationConfirmationLabel } from '../security/stagingExecutionGuard';

export const STAGING_DATABASE_SENTINEL_FORMAT = 'admin-cms-staging-database-sentinel/v1' as const;
export const STAGING_APPLICATION_ROLLBACK_FORMAT = 'admin-cms-staging-application-rollback/v1' as const;
export const STAGING_APPLICATION_POST_DEPLOY_FORMAT = 'admin-cms-staging-application-post-deploy/v1' as const;
export const DATABASE_SENTINEL_MAX_AGE_MS = 15 * 60 * 1_000;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/;
const MIGRATION_PATTERN = /^(\d{14})_[^/]+\.sql$/;
const SAFE_REF_PATTERN = /^(?:refs\/remotes\/)?origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#-]{2,127}$/;

const DATABASE_CONTRACT_PATH = 'apps/admin-cms/src/deployment/hostedDeploymentReadiness.ts';
const APPLICATION_PATH = 'apps/admin-cms';
const MIGRATIONS_PATH = 'infra/supabase/migrations';
const LOCKFILE_PATH = 'package-lock.json';

export type StagingDeploymentIntent = 'rollback' | 'redeploy';

export interface Gate4MachineAttestation {
  classification: 'GATE4_MATCH';
  repositoryGitSha: string;
  actualEvidenceSha256: string;
  totalDifferences: 0;
  differences: [];
  validationErrors: [];
}

export interface StagingDatabaseSentinel {
  formatVersion: typeof STAGING_DATABASE_SENTINEL_FORMAT;
  environment: 'staging';
  supabaseHost: string;
  observedAt: string;
  repositoryGitSha: string;
  repositoryMigrationVersions: string[];
  migrationTreeObject: string;
  databaseContractObject: string;
  gate4EvidenceSha256: string;
  gate4Classification: 'GATE4_MATCH';
  provenance: 'DIRECT_HOSTED_READ_ONLY' | 'UNAUTHENTICATED_FILE_INPUT_NOT_HOSTED_AUTHORITY';
}

export interface StagingRollbackGitEvidence {
  currentCommit: string;
  currentTree: string;
  currentBranch: string;
  trackedCheckoutClean: boolean;
  reviewedRef: string;
  reviewedRefCommit: string;
  currentDeployedCommit: string;
  currentDeployedReachableFromReviewedRef: boolean;
  targetCommit: string;
  targetReachableFromReviewedRef: boolean;
  targetTree: string;
  targetApplicationTree: string;
  targetLockfileObject: string;
  targetMigrationTree: string;
  currentMigrationTree: string;
  targetDatabaseContractObject: string;
  currentDatabaseContractObject: string;
  currentMigrationVersions: string[];
  targetMigrationVersions: string[];
}

export interface StagingRollbackEvidenceReferences {
  change: string;
  reviewApproval: string;
  ci: string;
  priorDeployment: string;
  priorSmoke: string;
  deploymentCredential: string;
}

export interface PrepareStagingRollbackOptions {
  intent: StagingDeploymentIntent;
  targetCommit: string;
  currentDeployedCommit: string;
  reviewedRef?: string;
  repositoryRoot: string;
  gitEvidence?: StagingRollbackGitEvidence;
  databaseSentinel: unknown;
  gate4EvidenceBytes: Buffer;
  gate4Evidence: unknown;
  databaseEvidenceAuthority: 'DIRECT_HOSTED_READ_ONLY' | 'NOT_PROVEN';
  currentDeploymentEvidence: CurrentDeploymentEvidence;
  evidenceReferences: StagingRollbackEvidenceReferences;
  env?: StagingRuntimeEnvironment;
  now?: Date;
  authorize?: boolean;
  confirmation?: string;
}

export type StagingRollbackBlocker =
  | 'INVALID_TARGET_COMMIT'
  | 'TARGET_COMMIT_UNREACHABLE'
  | 'TARGET_COMMIT_NOT_REVIEWED'
  | 'CURRENT_DEPLOYMENT_COMMIT_INVALID'
  | 'TOOLING_COMMIT_NOT_REVIEWED_HEAD'
  | 'TRACKED_CHECKOUT_DIRTY'
  | 'INVALID_REVIEWED_REF'
  | 'STAGING_CONFIGURATION_INVALID'
  | 'DEPLOYMENT_CREDENTIAL_EVIDENCE_MISSING'
  | 'REVIEW_OR_CI_EVIDENCE_MISSING'
  | 'DATABASE_SENTINEL_INVALID'
  | 'DATABASE_SENTINEL_STALE'
  | 'DATABASE_TARGET_IDENTITY_MISMATCH'
  | 'DATABASE_SENTINEL_EVIDENCE_MISMATCH'
  | 'DATABASE_AUTHORITY_NOT_PROVEN'
  | 'CURRENT_DEPLOYMENT_IDENTITY_NOT_PROVEN'
  | 'CURRENT_DEPLOYMENT_IDENTITY_MISMATCH'
  | 'DATABASE_MIGRATION_INCOMPATIBLE'
  | 'DATABASE_CAPABILITY_CONTRACT_INCOMPATIBLE'
  | 'ROLLBACK_TARGET_EQUALS_CURRENT_DEPLOYMENT'
  | 'REDEPLOY_TARGET_DIFFERS_FROM_CURRENT_DEPLOYMENT'
  | 'OPERATOR_AUTHORIZATION_REQUIRED'
  | 'OPERATOR_CONFIRMATION_INVALID';

export type StagingRollbackClassification =
  | 'DRY_RUN_READY_AUTHORIZATION_REQUIRED'
  | 'LOCAL_EVIDENCE_MATCH_DATABASE_AUTHORITY_NOT_PROVEN'
  | 'AUTHORIZED_FOR_MANUAL_PROVIDER_ACTION'
  | 'APPLICATION_ROLLBACK_REFUSED_DATABASE_FORWARD_RECOVERY_REQUIRED'
  | 'PREFLIGHT_BLOCKED';

export interface StagingRollbackPlan {
  formatVersion: typeof STAGING_APPLICATION_ROLLBACK_FORMAT;
  classification: StagingRollbackClassification;
  intent: StagingDeploymentIntent;
  environment: 'staging';
  target: {
    commit: string;
    tree: string;
    applicationTree: string;
    lockfileObject: string;
    migrationTree: string;
    databaseContractObject: string;
    sourceArtifactDigest: string;
  };
  previousApplicationCommit: string;
  currentDeploymentEvidence: CurrentDeploymentEvidence;
  reviewedRef: { name: string; commit: string };
  database: {
    observedAt: string;
    sentinelAgeMs: number;
    migrationCount: number;
    latestMigration: string;
    migrationTreeObject: string;
    gate4EvidenceSha256: string;
    databaseContractObject: string;
    compatibility: 'EXACT_MATCH' | 'INCOMPATIBLE' | 'UNVERIFIED';
    authority: 'DIRECT_HOSTED_READ_ONLY' | 'NOT_PROVEN';
    recoveryPolicy: 'FORWARD_ONLY_NO_IN_PLACE_DOWNGRADE';
  };
  evidenceReferences: StagingRollbackEvidenceReferences;
  authorization: {
    state: 'NOT_REQUESTED' | 'REQUIRED' | 'AUTHORIZED' | 'REFUSED';
    requiredConfirmation: string;
  };
  blockers: StagingRollbackBlocker[];
  hostedMutationPerformed: false;
  databaseMutationPerformed: false;
  publicationMutationPerformed: false;
  abortAndRecovery: string[];
  planDigest: string;
}

export interface StagingPostDeployEvidence {
  formatVersion: typeof STAGING_APPLICATION_POST_DEPLOY_FORMAT;
  planDigest: string;
  deploymentState: 'succeeded' | 'failed' | 'interrupted';
  deploymentReference: string;
  observedCommit?: string;
  smokeClassification?: string;
  observedMigrationCount?: number;
  observedLatestMigration?: string;
  gate4Classification?: string;
  databaseAuthority?: 'DIRECT_HOSTED_READ_ONLY';
  smokeAuthority?: 'DIRECT_PUBLIC_GET_HEAD';
}

export type StagingPostDeployClassification =
  | 'POST_DEPLOY_TECHNICALLY_VERIFIED_AUTHORIZATION_NOT_PROVEN'
  | 'DEPLOYMENT_INTERRUPTED'
  | 'POST_DEPLOY_READINESS_MISMATCH'
  | 'POST_DEPLOY_EVIDENCE_INVALID';

export interface StagingPostDeployResult {
  classification: StagingPostDeployClassification;
  accepted: boolean;
  technicalVerificationPassed: boolean;
  priorAuthorizationProven: false;
  blockers: string[];
  hostedMutationPerformedByThisTool: false;
  databaseMutationPerformed: false;
  publicationMutationPerformed: false;
  abortAndRecovery: string[];
}

export interface CurrentDeploymentEvidence {
  authority: 'DIRECT_PUBLIC_GET_HEAD' | 'NOT_PROVEN';
  expectedCommit: string;
  observedCommit: string;
  smokeClassification: string;
}

export async function collectCurrentDeploymentEvidence(options: {
  baseUrl: URL;
  currentDeployedCommit: string;
  migrationsDirectory: string;
  smokeRunner?: (input: {
    baseUrl: URL;
    expectedCommit: string;
    migrationsDirectory: string;
  }) => Promise<HostedSmokeReport>;
}): Promise<CurrentDeploymentEvidence> {
  const report = await (options.smokeRunner ?? runHostedSmokeVerifier)({
    baseUrl: options.baseUrl,
    expectedCommit: options.currentDeployedCommit,
    migrationsDirectory: options.migrationsDirectory,
  });
  return {
    authority: 'DIRECT_PUBLIC_GET_HEAD',
    expectedCommit: options.currentDeployedCommit,
    observedCommit: report.deploymentCommit.state === 'valid'
      ? report.deploymentCommit.value
      : 'UNAVAILABLE',
    smokeClassification: report.classification,
  };
}

export class StagingRollbackInputError extends Error {
  constructor(public readonly code: StagingRollbackBlocker | 'GIT_EVIDENCE_UNAVAILABLE') {
    super(code);
    this.name = 'StagingRollbackInputError';
  }
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function git(repositoryRoot: string, args: string[], allowFailure = false): string {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  if (result.status !== 0) {
    if (allowFailure) return '';
    throw new StagingRollbackInputError('GIT_EVIDENCE_UNAVAILABLE');
  }
  return result.stdout.trim();
}

function requireGitObject(value: string): string {
  const normalized = value.toLowerCase();
  if (!GIT_OBJECT_PATTERN.test(normalized)) {
    throw new StagingRollbackInputError('GIT_EVIDENCE_UNAVAILABLE');
  }
  return normalized;
}

function migrationVersionsFromPaths(paths: string[]): string[] {
  const versions = paths.map((file) => {
    const filename = path.posix.basename(file.replaceAll('\\', '/'));
    const version = MIGRATION_PATTERN.exec(filename)?.[1];
    if (!version) throw new StagingRollbackInputError('GIT_EVIDENCE_UNAVAILABLE');
    return version;
  }).sort();
  if (versions.length === 0 || new Set(versions).size !== versions.length) {
    throw new StagingRollbackInputError('GIT_EVIDENCE_UNAVAILABLE');
  }
  return versions;
}

function migrationVersionsAtCommit(repositoryRoot: string, commit: string): string[] {
  const files = git(repositoryRoot, ['ls-tree', '-r', '--name-only', commit, '--', MIGRATIONS_PATH])
    .split(/\r?\n/)
    .filter((file) => file.endsWith('.sql'));
  return migrationVersionsFromPaths(files);
}

function currentMigrationVersions(repositoryRoot: string): string[] {
  const directory = path.join(repositoryRoot, ...MIGRATIONS_PATH.split('/'));
  return migrationVersionsFromPaths(fs.readdirSync(directory)
    .filter((file) => file.endsWith('.sql')));
}

function objectAtCommit(repositoryRoot: string, commit: string, objectPath: string): string {
  return requireGitObject(git(repositoryRoot, ['rev-parse', `${commit}:${objectPath}`]));
}

export function collectStagingRollbackGitEvidence(
  repositoryRoot: string,
  targetCommitInput: string,
  reviewedRef = 'origin/main',
  currentDeployedCommitInput = targetCommitInput,
): StagingRollbackGitEvidence {
  const targetCommit = targetCommitInput.toLowerCase();
  if (!FULL_SHA_PATTERN.test(targetCommit)) {
    throw new StagingRollbackInputError('INVALID_TARGET_COMMIT');
  }
  if (!SAFE_REF_PATTERN.test(reviewedRef)) {
    throw new StagingRollbackInputError('INVALID_REVIEWED_REF');
  }
  const currentDeployedCommit = currentDeployedCommitInput.toLowerCase();
  if (!FULL_SHA_PATTERN.test(currentDeployedCommit)) {
    throw new StagingRollbackInputError('CURRENT_DEPLOYMENT_COMMIT_INVALID');
  }

  const resolvedTarget = git(repositoryRoot, ['rev-parse', '--verify', `${targetCommit}^{commit}`], true)
    .toLowerCase();
  if (resolvedTarget !== targetCommit) {
    throw new StagingRollbackInputError('TARGET_COMMIT_UNREACHABLE');
  }
  const resolvedCurrentDeployment = git(
    repositoryRoot,
    ['rev-parse', '--verify', `${currentDeployedCommit}^{commit}`],
    true,
  ).toLowerCase();
  if (resolvedCurrentDeployment !== currentDeployedCommit) {
    throw new StagingRollbackInputError('CURRENT_DEPLOYMENT_COMMIT_INVALID');
  }

  const currentCommit = git(repositoryRoot, ['rev-parse', 'HEAD']).toLowerCase();
  const reviewedRefCommit = git(repositoryRoot, ['rev-parse', '--verify', `${reviewedRef}^{commit}`], true)
    .toLowerCase();
  if (!FULL_SHA_PATTERN.test(reviewedRefCommit)) {
    throw new StagingRollbackInputError('INVALID_REVIEWED_REF');
  }

  return {
    currentCommit,
    currentTree: requireGitObject(git(repositoryRoot, ['rev-parse', `${currentCommit}^{tree}`])),
    currentBranch: git(repositoryRoot, ['branch', '--show-current']) || 'DETACHED',
    trackedCheckoutClean: git(repositoryRoot, ['status', '--porcelain', '--untracked-files=no']) === '',
    reviewedRef,
    reviewedRefCommit,
    currentDeployedCommit,
    currentDeployedReachableFromReviewedRef: spawnSync(
      'git',
      ['merge-base', '--is-ancestor', currentDeployedCommit, reviewedRefCommit],
      { cwd: repositoryRoot, stdio: 'ignore', timeout: 30_000 },
    ).status === 0,
    targetCommit,
    targetReachableFromReviewedRef: spawnSync(
      'git',
      ['merge-base', '--is-ancestor', targetCommit, reviewedRefCommit],
      { cwd: repositoryRoot, stdio: 'ignore', timeout: 30_000 },
    ).status === 0,
    targetTree: requireGitObject(git(repositoryRoot, ['rev-parse', `${targetCommit}^{tree}`])),
    targetApplicationTree: objectAtCommit(repositoryRoot, targetCommit, APPLICATION_PATH),
    targetLockfileObject: objectAtCommit(repositoryRoot, targetCommit, LOCKFILE_PATH),
    targetMigrationTree: objectAtCommit(repositoryRoot, targetCommit, MIGRATIONS_PATH),
    currentMigrationTree: objectAtCommit(repositoryRoot, currentCommit, MIGRATIONS_PATH),
    targetDatabaseContractObject: objectAtCommit(repositoryRoot, targetCommit, DATABASE_CONTRACT_PATH),
    currentDatabaseContractObject: objectAtCommit(repositoryRoot, currentCommit, DATABASE_CONTRACT_PATH),
    currentMigrationVersions: currentMigrationVersions(repositoryRoot),
    targetMigrationVersions: migrationVersionsAtCommit(repositoryRoot, targetCommit),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function parseSentinel(input: unknown): StagingDatabaseSentinel | null {
  if (!isObject(input) || !exactKeys(input, [
    'formatVersion', 'environment', 'supabaseHost', 'observedAt', 'repositoryGitSha',
    'repositoryMigrationVersions', 'migrationTreeObject', 'databaseContractObject', 'gate4EvidenceSha256',
    'gate4Classification', 'provenance',
  ])) return null;
  const migrations = input.repositoryMigrationVersions;
  if (input.formatVersion !== STAGING_DATABASE_SENTINEL_FORMAT
    || input.environment !== 'staging'
    || typeof input.supabaseHost !== 'string'
    || typeof input.observedAt !== 'string'
    || !FULL_SHA_PATTERN.test(String(input.repositoryGitSha ?? ''))
    || !Array.isArray(migrations)
    || migrations.length === 0
    || migrations.some((version) => typeof version !== 'string' || !/^\d{14}$/.test(version))
    || new Set(migrations).size !== migrations.length
    || !GIT_OBJECT_PATTERN.test(String(input.migrationTreeObject ?? ''))
    || !GIT_OBJECT_PATTERN.test(String(input.databaseContractObject ?? ''))
    || !/^[0-9a-f]{64}$/.test(String(input.gate4EvidenceSha256 ?? ''))
    || input.gate4Classification !== 'GATE4_MATCH'
    || !['DIRECT_HOSTED_READ_ONLY', 'UNAUTHENTICATED_FILE_INPUT_NOT_HOSTED_AUTHORITY']
      .includes(String(input.provenance ?? ''))) return null;
  return input as unknown as StagingDatabaseSentinel;
}

function parseGate4Attestation(input: unknown): Gate4MachineAttestation | null {
  if (!isObject(input)
    || input.classification !== 'GATE4_MATCH'
    || !FULL_SHA_PATTERN.test(String(input.repositoryGitSha ?? ''))
    || !/^[0-9a-f]{64}$/.test(String(input.actualEvidenceSha256 ?? ''))
    || input.totalDifferences !== 0
    || !Array.isArray(input.differences)
    || input.differences.length !== 0
    || !Array.isArray(input.validationErrors)
    || input.validationErrors.length !== 0) return null;
  return input as unknown as Gate4MachineAttestation;
}

export function createStagingDatabaseSentinel(options: {
  repositoryRoot: string;
  gitEvidence: StagingRollbackGitEvidence;
  gate4EvidenceBytes: Buffer;
  gate4Evidence: unknown;
  gate4Attestation: unknown;
  observedAt: string;
  provenance: StagingDatabaseSentinel['provenance'];
  env?: StagingRuntimeEnvironment;
  now?: Date;
}): StagingDatabaseSentinel {
  const env = options.env ?? process.env;
  try {
    assertVerifiedStagingRuntime(env);
  } catch {
    throw new StagingRollbackInputError('STAGING_CONFIGURATION_INVALID');
  }
  const attestation = parseGate4Attestation(options.gate4Attestation);
  const parsedEvidence = parseGate4Evidence(options.gate4Evidence);
  const observedMs = Date.parse(options.observedAt);
  const nowMs = (options.now ?? new Date()).getTime();
  if (!attestation || attestation.repositoryGitSha !== options.gitEvidence.currentCommit
    || attestation.actualEvidenceSha256 !== sha256(options.gate4EvidenceBytes)
    || !options.gitEvidence.trackedCheckoutClean
    || !options.gitEvidence.targetReachableFromReviewedRef
    || options.gitEvidence.currentCommit !== options.gitEvidence.reviewedRefCommit
    || !parsedEvidence.ok
    || validateCurrentRepositoryGate4Contract(
      options.gate4Evidence,
      options.gitEvidence.currentMigrationVersions,
    ).length > 0
    || Number.isNaN(observedMs)
    || observedMs > nowMs
    || nowMs - observedMs > DATABASE_SENTINEL_MAX_AGE_MS) {
    throw new StagingRollbackInputError('DATABASE_SENTINEL_INVALID');
  }

  return {
    formatVersion: STAGING_DATABASE_SENTINEL_FORMAT,
    environment: 'staging',
    supabaseHost: env.CAPSTONE_EXPECTED_SUPABASE_HOST!,
    observedAt: new Date(observedMs).toISOString(),
    repositoryGitSha: options.gitEvidence.currentCommit,
    repositoryMigrationVersions: [...parsedEvidence.evidence.migrations].sort(),
    migrationTreeObject: options.gitEvidence.currentMigrationTree,
    databaseContractObject: options.gitEvidence.currentDatabaseContractObject,
    gate4EvidenceSha256: sha256(options.gate4EvidenceBytes),
    gate4Classification: 'GATE4_MATCH',
    provenance: options.provenance,
  };
}

function requiredConfirmation(
  label: string | undefined,
  intent: StagingDeploymentIntent,
  targetCommit: string,
): string {
  return label && isValidMutationConfirmationLabel(label)
    ? `${label}:${intent}:${targetCommit}`
    : 'UNAVAILABLE';
}

function validReference(value: string): boolean {
  return SAFE_EVIDENCE_REFERENCE_PATTERN.test(value)
    && !value.includes('@')
    && !/(?:sb_secret_|eyJ[A-Za-z0-9_-]{8,}|SERVICE_ROLE_KEY)/.test(value);
}

function abortGuidance(previousCommit: string): string[] {
  return [
    'Do not change, downgrade, repair, restore, or delete hosted database or Storage state.',
    'Do not invoke Duda, public-feed publication, public-feed rollback, email, or other publication endpoints.',
    'Keep staff mutation access blocked until exact-SHA readiness and independent Gate 3/4 evidence pass.',
    `If the deployment cannot be completed safely, an authorized operator may redeploy the prior application commit ${previousCommit}.`,
    'If database evidence advanced or drifted, stop application rollback and forward-recover the application against the current database manifest.',
  ];
}

function planDigest(plan: Omit<StagingRollbackPlan, 'planDigest'>): string {
  return `sha256:${sha256(JSON.stringify(plan))}`;
}

export function prepareStagingApplicationRollback(
  options: PrepareStagingRollbackOptions,
): StagingRollbackPlan {
  const blockers: StagingRollbackBlocker[] = [];
  let environmentValid = true;
  const env = options.env ?? process.env;
  try {
    assertVerifiedStagingRuntime(env);
  } catch {
    environmentValid = false;
    blockers.push('STAGING_CONFIGURATION_INVALID');
  }

  const gitEvidence = options.gitEvidence ?? collectStagingRollbackGitEvidence(
    options.repositoryRoot,
    options.targetCommit,
    options.reviewedRef,
    options.currentDeployedCommit,
  );
  if (!FULL_SHA_PATTERN.test(options.targetCommit.toLowerCase())
    || options.targetCommit.toLowerCase() !== gitEvidence.targetCommit) {
    blockers.push('INVALID_TARGET_COMMIT');
  }
  if (!FULL_SHA_PATTERN.test(options.currentDeployedCommit.toLowerCase())
    || options.currentDeployedCommit.toLowerCase() !== gitEvidence.currentDeployedCommit) {
    blockers.push('CURRENT_DEPLOYMENT_COMMIT_INVALID');
  }
  if (!gitEvidence.trackedCheckoutClean) blockers.push('TRACKED_CHECKOUT_DIRTY');
  if (!gitEvidence.targetReachableFromReviewedRef) blockers.push('TARGET_COMMIT_NOT_REVIEWED');
  if (!gitEvidence.currentDeployedReachableFromReviewedRef) {
    blockers.push('CURRENT_DEPLOYMENT_COMMIT_INVALID');
  }
  if (gitEvidence.currentCommit !== gitEvidence.reviewedRefCommit) {
    blockers.push('TOOLING_COMMIT_NOT_REVIEWED_HEAD');
  }
  if (options.databaseEvidenceAuthority !== 'DIRECT_HOSTED_READ_ONLY') {
    blockers.push('DATABASE_AUTHORITY_NOT_PROVEN');
  }
  if (options.currentDeploymentEvidence.authority !== 'DIRECT_PUBLIC_GET_HEAD') {
    blockers.push('CURRENT_DEPLOYMENT_IDENTITY_NOT_PROVEN');
  } else if (options.currentDeploymentEvidence.expectedCommit !== gitEvidence.currentDeployedCommit
    || options.currentDeploymentEvidence.observedCommit !== gitEvidence.currentDeployedCommit
    || options.currentDeploymentEvidence.smokeClassification !== 'READY_FOR_SUPERVISED_UAT') {
    blockers.push('CURRENT_DEPLOYMENT_IDENTITY_MISMATCH');
  }

  const refs = options.evidenceReferences;
  if (![refs.change, refs.reviewApproval, refs.ci, refs.priorDeployment, refs.priorSmoke]
    .every(validReference)) blockers.push('REVIEW_OR_CI_EVIDENCE_MISSING');
  if (!validReference(refs.deploymentCredential)) {
    blockers.push('DEPLOYMENT_CREDENTIAL_EVIDENCE_MISSING');
  }

  const sentinel = parseSentinel(options.databaseSentinel);
  const parsedGate4 = parseGate4Evidence(options.gate4Evidence);
  const nowMs = (options.now ?? new Date()).getTime();
  let sentinelAgeMs = -1;
  let databaseCompatibility: StagingRollbackPlan['database']['compatibility'] = 'UNVERIFIED';
  if (!sentinel || !parsedGate4.ok) {
    blockers.push('DATABASE_SENTINEL_INVALID');
  } else {
    if (options.databaseEvidenceAuthority === 'DIRECT_HOSTED_READ_ONLY'
      && sentinel.provenance !== 'DIRECT_HOSTED_READ_ONLY'
      && !blockers.includes('DATABASE_AUTHORITY_NOT_PROVEN')) {
      blockers.push('DATABASE_AUTHORITY_NOT_PROVEN');
    }
    const observedMs = Date.parse(sentinel.observedAt);
    sentinelAgeMs = nowMs - observedMs;
    if (Number.isNaN(observedMs) || sentinelAgeMs < 0) {
      blockers.push('DATABASE_SENTINEL_INVALID');
    } else if (sentinelAgeMs > DATABASE_SENTINEL_MAX_AGE_MS) {
      blockers.push('DATABASE_SENTINEL_STALE');
    }
    if (environmentValid && sentinel.supabaseHost !== env.CAPSTONE_EXPECTED_SUPABASE_HOST) {
      blockers.push('DATABASE_TARGET_IDENTITY_MISMATCH');
    }
    if (sentinel.repositoryGitSha !== gitEvidence.currentCommit
      || sentinel.gate4EvidenceSha256 !== sha256(options.gate4EvidenceBytes)
      || sentinel.gate4Classification !== 'GATE4_MATCH'
      || JSON.stringify([...parsedGate4.evidence.migrations].sort())
        !== JSON.stringify([...sentinel.repositoryMigrationVersions].sort())
      || validateCurrentRepositoryGate4Contract(
        options.gate4Evidence,
        gitEvidence.currentMigrationVersions,
      ).length > 0) {
      blockers.push('DATABASE_SENTINEL_EVIDENCE_MISMATCH');
    }
    const exactManifest = gitEvidence.targetMigrationTree === gitEvidence.currentMigrationTree
      && gitEvidence.targetMigrationTree === sentinel.migrationTreeObject
      && JSON.stringify(gitEvidence.targetMigrationVersions)
      === JSON.stringify(gitEvidence.currentMigrationVersions)
      && JSON.stringify(gitEvidence.targetMigrationVersions)
        === JSON.stringify([...sentinel.repositoryMigrationVersions].sort());
    if (!exactManifest) blockers.push('DATABASE_MIGRATION_INCOMPATIBLE');
    const exactContract = gitEvidence.targetDatabaseContractObject
      === gitEvidence.currentDatabaseContractObject
      && gitEvidence.targetDatabaseContractObject === sentinel.databaseContractObject;
    if (!exactContract) blockers.push('DATABASE_CAPABILITY_CONTRACT_INCOMPATIBLE');
    databaseCompatibility = exactManifest && exactContract ? 'EXACT_MATCH' : 'INCOMPATIBLE';
  }

  if (options.intent === 'rollback'
    && gitEvidence.targetCommit === gitEvidence.currentDeployedCommit) {
    blockers.push('ROLLBACK_TARGET_EQUALS_CURRENT_DEPLOYMENT');
  }
  if (options.intent === 'redeploy'
    && gitEvidence.targetCommit !== gitEvidence.currentDeployedCommit) {
    blockers.push('REDEPLOY_TARGET_DIFFERS_FROM_CURRENT_DEPLOYMENT');
  }

  const expectedConfirmation = requiredConfirmation(
    env.CAPSTONE_STAGING_MUTATION_CONFIRMATION,
    options.intent,
    gitEvidence.targetCommit,
  );
  let authorizationState: StagingRollbackPlan['authorization']['state'] = 'NOT_REQUESTED';
  if (options.authorize) {
    authorizationState = 'REFUSED';
    if (expectedConfirmation === 'UNAVAILABLE') {
      if (!blockers.includes('STAGING_CONFIGURATION_INVALID')) {
        blockers.push('STAGING_CONFIGURATION_INVALID');
      }
    } else if (options.confirmation !== expectedConfirmation) {
      blockers.push('OPERATOR_CONFIRMATION_INVALID');
    }
  } else {
    authorizationState = blockers.length === 0 ? 'REQUIRED' : 'NOT_REQUESTED';
    if (blockers.length === 0) blockers.push('OPERATOR_AUTHORIZATION_REQUIRED');
  }

  const databaseIncompatible = blockers.includes('DATABASE_MIGRATION_INCOMPATIBLE')
    || blockers.includes('DATABASE_CAPABILITY_CONTRACT_INCOMPATIBLE');
  const onlyAuthorizationBlocker = blockers.length === 1
    && blockers[0] === 'OPERATOR_AUTHORIZATION_REQUIRED';
  const onlyUnprovenAuthority = blockers.length === 2
    && blockers.includes('DATABASE_AUTHORITY_NOT_PROVEN')
    && blockers.includes('CURRENT_DEPLOYMENT_IDENTITY_NOT_PROVEN')
    && !options.authorize;
  const classification: StagingRollbackClassification = databaseIncompatible
    ? 'APPLICATION_ROLLBACK_REFUSED_DATABASE_FORWARD_RECOVERY_REQUIRED'
    : onlyUnprovenAuthority
      ? 'LOCAL_EVIDENCE_MATCH_DATABASE_AUTHORITY_NOT_PROVEN'
    : onlyAuthorizationBlocker
      ? 'DRY_RUN_READY_AUTHORIZATION_REQUIRED'
      : blockers.length === 0 && options.authorize
        ? 'AUTHORIZED_FOR_MANUAL_PROVIDER_ACTION'
        : 'PREFLIGHT_BLOCKED';
  if (classification === 'AUTHORIZED_FOR_MANUAL_PROVIDER_ACTION') authorizationState = 'AUTHORIZED';

  const latestMigration = sentinel?.repositoryMigrationVersions.at(-1) ?? 'UNAVAILABLE';
  const artifactIdentity = [
    gitEvidence.targetCommit,
    gitEvidence.targetTree,
    gitEvidence.targetApplicationTree,
    gitEvidence.targetLockfileObject,
    gitEvidence.targetMigrationTree,
    gitEvidence.targetDatabaseContractObject,
  ].join('\n');
  const withoutDigest: Omit<StagingRollbackPlan, 'planDigest'> = {
    formatVersion: STAGING_APPLICATION_ROLLBACK_FORMAT,
    classification,
    intent: options.intent,
    environment: 'staging',
    target: {
      commit: gitEvidence.targetCommit,
      tree: gitEvidence.targetTree,
      applicationTree: gitEvidence.targetApplicationTree,
      lockfileObject: gitEvidence.targetLockfileObject,
      migrationTree: gitEvidence.targetMigrationTree,
      databaseContractObject: gitEvidence.targetDatabaseContractObject,
      sourceArtifactDigest: `sha256:${sha256(artifactIdentity)}`,
    },
    previousApplicationCommit: gitEvidence.currentDeployedCommit,
    currentDeploymentEvidence: options.currentDeploymentEvidence,
    reviewedRef: { name: gitEvidence.reviewedRef, commit: gitEvidence.reviewedRefCommit },
    database: {
      observedAt: sentinel?.observedAt ?? 'UNAVAILABLE',
      sentinelAgeMs,
      migrationCount: sentinel?.repositoryMigrationVersions.length ?? 0,
      latestMigration,
      migrationTreeObject: sentinel?.migrationTreeObject ?? 'UNAVAILABLE',
      gate4EvidenceSha256: sentinel?.gate4EvidenceSha256 ?? 'UNAVAILABLE',
      databaseContractObject: sentinel?.databaseContractObject ?? 'UNAVAILABLE',
      compatibility: databaseCompatibility,
      authority: options.databaseEvidenceAuthority,
      recoveryPolicy: 'FORWARD_ONLY_NO_IN_PLACE_DOWNGRADE',
    },
    evidenceReferences: refs,
    authorization: { state: authorizationState, requiredConfirmation: expectedConfirmation },
    blockers,
    hostedMutationPerformed: false,
    databaseMutationPerformed: false,
    publicationMutationPerformed: false,
    abortAndRecovery: abortGuidance(gitEvidence.currentDeployedCommit),
  };
  return { ...withoutDigest, planDigest: planDigest(withoutDigest) };
}

export function verifyStagingApplicationPostDeploy(
  plan: StagingRollbackPlan,
  evidence: unknown,
): StagingPostDeployResult {
  const recovery = abortGuidance(
    FULL_SHA_PATTERN.test(plan?.previousApplicationCommit ?? '')
      ? plan.previousApplicationCommit
      : 'the recorded prior exact commit',
  );
  const { planDigest: recordedPlanDigest, ...planWithoutDigest } = plan ?? {} as StagingRollbackPlan;
  const validPlan = plan?.formatVersion === STAGING_APPLICATION_ROLLBACK_FORMAT
    && plan.classification === 'AUTHORIZED_FOR_MANUAL_PROVIDER_ACTION'
    && typeof recordedPlanDigest === 'string'
    && recordedPlanDigest === planDigest(planWithoutDigest as Omit<StagingRollbackPlan, 'planDigest'>);
  if (!validPlan
    || !isObject(evidence)
    || evidence.formatVersion !== STAGING_APPLICATION_POST_DEPLOY_FORMAT
    || evidence.planDigest !== recordedPlanDigest
    || !validReference(String(evidence.deploymentReference ?? ''))
    || !['succeeded', 'failed', 'interrupted'].includes(String(evidence.deploymentState ?? ''))) {
    return {
      classification: 'POST_DEPLOY_EVIDENCE_INVALID', accepted: false,
      blockers: ['POST_DEPLOY_EVIDENCE_INVALID'],
      technicalVerificationPassed: false, priorAuthorizationProven: false,
      hostedMutationPerformedByThisTool: false, databaseMutationPerformed: false,
      publicationMutationPerformed: false, abortAndRecovery: recovery,
    };
  }
  const typed = evidence as unknown as StagingPostDeployEvidence;
  if (typed.deploymentState === 'interrupted') {
    return {
      classification: 'DEPLOYMENT_INTERRUPTED', accepted: false,
      blockers: ['DEPLOYMENT_DID_NOT_REACH_A_TERMINAL_READY_STATE'],
      technicalVerificationPassed: false, priorAuthorizationProven: false,
      hostedMutationPerformedByThisTool: false, databaseMutationPerformed: false,
      publicationMutationPerformed: false, abortAndRecovery: recovery,
    };
  }
  const mismatches: string[] = [];
  if (typed.deploymentState !== 'succeeded') mismatches.push('DEPLOYMENT_FAILED');
  if (typed.observedCommit !== plan.target.commit) mismatches.push('DEPLOYMENT_COMMIT_MISMATCH');
  if (typed.smokeClassification !== 'READY_FOR_SUPERVISED_UAT') {
    mismatches.push('READINESS_OR_SMOKE_MISMATCH');
  }
  if (typed.observedMigrationCount !== plan.database.migrationCount
    || typed.observedLatestMigration !== plan.database.latestMigration) {
    mismatches.push('DEPLOYED_MIGRATION_EXPECTATION_MISMATCH');
  }
  if (typed.gate4Classification !== 'GATE4_MATCH') {
    mismatches.push('POST_DEPLOY_GATE4_NOT_MATCHED');
  }
  if (typed.databaseAuthority !== 'DIRECT_HOSTED_READ_ONLY') {
    mismatches.push('POST_DEPLOY_DATABASE_AUTHORITY_NOT_PROVEN');
  }
  if (typed.smokeAuthority !== 'DIRECT_PUBLIC_GET_HEAD') {
    mismatches.push('POST_DEPLOY_SMOKE_AUTHORITY_NOT_PROVEN');
  }
  return {
    classification: mismatches.length === 0
      ? 'POST_DEPLOY_TECHNICALLY_VERIFIED_AUTHORIZATION_NOT_PROVEN'
      : 'POST_DEPLOY_READINESS_MISMATCH',
    accepted: false,
    technicalVerificationPassed: mismatches.length === 0,
    priorAuthorizationProven: false,
    blockers: mismatches,
    hostedMutationPerformedByThisTool: false,
    databaseMutationPerformed: false,
    publicationMutationPerformed: false,
    abortAndRecovery: recovery,
  };
}

export function formatStagingRollbackReport(plan: StagingRollbackPlan): string {
  return [
    'ADMIN/CMS STAGING APPLICATION ROLLBACK PREFLIGHT',
    `CLASSIFICATION = ${plan.classification}`,
    `INTENT = ${plan.intent}`,
    `TARGET_COMMIT = ${plan.target.commit}`,
    `SOURCE_ARTIFACT_DIGEST = ${plan.target.sourceArtifactDigest}`,
    `REVIEWED_REF_COMMIT = ${plan.reviewedRef.commit}`,
    `DATABASE_COMPATIBILITY = ${plan.database.compatibility}`,
    `DATABASE_MIGRATIONS = count=${plan.database.migrationCount} latest=${plan.database.latestMigration}`,
    `AUTHORIZATION = ${plan.authorization.state}`,
    `BLOCKERS = ${plan.blockers.length === 0 ? 'NONE' : plan.blockers.join(',')}`,
    'HOSTED_MUTATION_PERFORMED = NO',
    'DATABASE_MUTATION_PERFORMED = NO',
    'PUBLICATION_MUTATION_PERFORMED = NO',
    `PLAN_DIGEST = ${plan.planDigest}`,
    ...plan.abortAndRecovery.map((step, index) => `ABORT_RECOVERY_${index + 1} = ${step}`),
  ].join('\n');
}

export function readBoundedJsonFile(file: string, maxBytes = 10 * 1024 * 1024): {
  value: unknown;
  bytes: Buffer;
} {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
    throw new StagingRollbackInputError('DATABASE_SENTINEL_INVALID');
  }
  const bytes = fs.readFileSync(resolved);
  try {
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
  } catch {
    throw new StagingRollbackInputError('DATABASE_SENTINEL_INVALID');
  }
}

export function currentRepositoryCommit(repositoryRoot: string): string {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().toLowerCase();
  if (!FULL_SHA_PATTERN.test(commit)) throw new StagingRollbackInputError('GIT_EVIDENCE_UNAVAILABLE');
  return commit;
}
