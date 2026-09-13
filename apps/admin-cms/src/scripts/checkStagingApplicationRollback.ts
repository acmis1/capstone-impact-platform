import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  compareGate4Evidence,
  validateCurrentRepositoryGate4Contract,
} from '../deployment/gate4SchemaEvidence';
import {
  parseHostedSmokeBaseUrl,
  runHostedSmokeVerifier,
} from '../deployment/hostedDeploymentSmokeVerifier';
import {
  collectStagingRollbackGitEvidence,
  collectCurrentDeploymentEvidence,
  createStagingDatabaseSentinel,
  formatStagingRollbackReport,
  prepareStagingApplicationRollback,
  readBoundedJsonFile,
  STAGING_APPLICATION_POST_DEPLOY_FORMAT,
  StagingRollbackInputError,
  verifyStagingApplicationPostDeploy,
  type StagingDatabaseSentinel,
  type StagingDeploymentIntent,
  type StagingRollbackEvidenceReferences,
  type StagingRollbackGitEvidence,
  type StagingRollbackPlan,
} from '../operations/stagingApplicationRollback';
import {
  APPROVED_HOSTED_SOURCE_PROJECT_REF,
} from '../recovery/zeroCostRecoveryContract';
import {
  readGate4SourceEvidence,
  readLinkedProjectRef,
} from '../recovery/supabaseRecoveryCli';
import { assertVerifiedStagingRuntime } from '../security/stagingRuntimeIdentity';
import { collectLocalGate4Evidence, unwrapEvidenceDocument } from './checkGate4SchemaEvidence';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const supabaseWorkdir = path.join(repositoryRoot, 'infra');
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#-]{2,127}$/;

type Command = 'local-preflight' | 'preflight' | 'post-deploy';

export interface StagingRollbackCliOptions {
  command: Command;
  values: Record<string, string>;
  authorize: boolean;
  json: boolean;
}

const VALUE_OPTIONS = new Set([
  'target-commit', 'current-deployed-commit', 'reviewed-ref', 'gate4-evidence',
  'gate4-attestation', 'observed-at', 'change-reference',
  'review-approval-reference', 'ci-reference', 'prior-deployment-reference',
  'prior-smoke-reference', 'deployment-credential-reference', 'intent', 'confirmation',
  'plan', 'deployment-state', 'deployment-reference', 'base-url',
]);

export function parseStagingRollbackCliArgs(args: readonly string[]): StagingRollbackCliOptions {
  const [command, ...rest] = args;
  if (!['local-preflight', 'preflight', 'post-deploy'].includes(command ?? '')) {
    throw new Error('COMMAND_INVALID');
  }
  const values: Record<string, string> = {};
  let authorize = false;
  let json = false;
  for (const argument of rest) {
    if (argument === '--authorize') {
      if (authorize) throw new Error('DUPLICATE_OPTION');
      authorize = true;
      continue;
    }
    if (argument === '--json') {
      if (json) throw new Error('DUPLICATE_OPTION');
      json = true;
      continue;
    }
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match || !VALUE_OPTIONS.has(match[1]) || values[match[1]] !== undefined) {
      throw new Error('OPTION_INVALID');
    }
    values[match[1]] = match[2];
  }
  return { command: command as Command, values, authorize, json };
}

function requireValue(options: StagingRollbackCliOptions, name: string): string {
  const value = options.values[name];
  if (!value) throw new Error('REQUIRED_OPTION_MISSING');
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function validEvidenceReference(value: string): boolean {
  return SAFE_REFERENCE_PATTERN.test(value)
    && !value.includes('@')
    && !/(?:sb_secret_|eyJ[A-Za-z0-9_-]{8,}|SERVICE_ROLE_KEY)/.test(value);
}

function evidenceReferences(options: StagingRollbackCliOptions): StagingRollbackEvidenceReferences {
  const references = {
    change: requireValue(options, 'change-reference'),
    reviewApproval: requireValue(options, 'review-approval-reference'),
    ci: requireValue(options, 'ci-reference'),
    priorDeployment: requireValue(options, 'prior-deployment-reference'),
    priorSmoke: requireValue(options, 'prior-smoke-reference'),
    deploymentCredential: requireValue(options, 'deployment-credential-reference'),
  };
  if (!Object.values(references).every(validEvidenceReference)) {
    throw new Error('EVIDENCE_REFERENCE_INVALID');
  }
  return references;
}

function assertLocalGitPreflight(gitEvidence: StagingRollbackGitEvidence): void {
  if (!gitEvidence.trackedCheckoutClean) {
    throw new StagingRollbackInputError('TRACKED_CHECKOUT_DIRTY');
  }
  if (!gitEvidence.targetReachableFromReviewedRef) {
    throw new StagingRollbackInputError('TARGET_COMMIT_NOT_REVIEWED');
  }
  if (!gitEvidence.currentDeployedReachableFromReviewedRef) {
    throw new StagingRollbackInputError('CURRENT_DEPLOYMENT_COMMIT_INVALID');
  }
  if (gitEvidence.currentCommit !== gitEvidence.reviewedRefCommit) {
    throw new StagingRollbackInputError('TOOLING_COMMIT_NOT_REVIEWED_HEAD');
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Establishes database authority in the running process. No operator-supplied evidence file can
 * reach this path: the repository-pinned CLI reads the exact linked staging project with a
 * read-only transaction guard, then compares it with the current disposable Local contract.
 */
function collectDirectHostedDatabaseEvidence(
  gitEvidence: StagingRollbackGitEvidence,
  now: Date,
): { sentinel: StagingDatabaseSentinel; evidence: unknown; bytes: Buffer } {
  assertVerifiedStagingRuntime(process.env);
  const expectedHost = `${APPROVED_HOSTED_SOURCE_PROJECT_REF}.supabase.co`;
  if (process.env.CAPSTONE_EXPECTED_SUPABASE_HOST !== expectedHost
    || readLinkedProjectRef(supabaseWorkdir) !== APPROVED_HOSTED_SOURCE_PROJECT_REF) {
    throw new StagingRollbackInputError('DATABASE_TARGET_IDENTITY_MISMATCH');
  }
  if (!process.env.SUPABASE_ACCESS_TOKEN?.trim()) {
    throw new Error('DATABASE_READ_CREDENTIAL_MISSING');
  }

  const expected = collectLocalGate4Evidence(repositoryRoot);
  const expectedErrors = validateCurrentRepositoryGate4Contract(
    expected,
    gitEvidence.currentMigrationVersions,
  );
  if (expectedErrors.length > 0) throw new Error('LOCAL_DATABASE_CONTRACT_INVALID');

  const evidence = readGate4SourceEvidence(
    repositoryRoot,
    { kind: 'hosted-linked', workdir: supabaseWorkdir },
  );
  const comparison = compareGate4Evidence(expected, evidence);
  if (comparison.classification !== 'GATE4_MATCH'
    || comparison.totalDifferences !== 0
    || comparison.validationErrors.length !== 0) {
    throw new StagingRollbackInputError('DATABASE_AUTHORITY_NOT_PROVEN');
  }
  const bytes = Buffer.from(JSON.stringify(evidence));
  const sentinel = createStagingDatabaseSentinel({
    repositoryRoot,
    gitEvidence,
    gate4EvidenceBytes: bytes,
    gate4Evidence: evidence,
    gate4Attestation: {
      classification: 'GATE4_MATCH',
      repositoryGitSha: gitEvidence.currentCommit,
      actualEvidenceSha256: sha256(bytes),
      totalDifferences: 0,
      differences: [],
      validationErrors: [],
    },
    observedAt: now.toISOString(),
    provenance: 'DIRECT_HOSTED_READ_ONLY',
    now,
  });
  return { sentinel, evidence, bytes };
}

function loadLocalUnprovenEvidence(
  options: StagingRollbackCliOptions,
  gitEvidence: StagingRollbackGitEvidence,
  now: Date,
): {
  sentinel: StagingDatabaseSentinel;
  evidence: unknown;
  bytes: Buffer;
} {
  if (options.authorize) throw new Error('LOCAL_EVIDENCE_CANNOT_AUTHORIZE');
  const gate4 = readBoundedJsonFile(requireValue(options, 'gate4-evidence'));
  const attestation = readBoundedJsonFile(
    requireValue(options, 'gate4-attestation'),
    2 * 1024 * 1024,
  );
  const sentinel = createStagingDatabaseSentinel({
    repositoryRoot,
    gitEvidence,
    gate4EvidenceBytes: gate4.bytes,
    gate4Evidence: unwrapEvidenceDocument(gate4.value),
    gate4Attestation: attestation.value,
    observedAt: requireValue(options, 'observed-at'),
    provenance: 'UNAUTHENTICATED_FILE_INPUT_NOT_HOSTED_AUTHORITY',
    now,
  });
  return { sentinel, evidence: unwrapEvidenceDocument(gate4.value), bytes: gate4.bytes };
}

function rollbackIntent(options: StagingRollbackCliOptions): StagingDeploymentIntent {
  const intent = requireValue(options, 'intent');
  if (!['rollback', 'redeploy'].includes(intent)) throw new Error('INTENT_INVALID');
  return intent as StagingDeploymentIntent;
}

async function prepareFromOptions(options: StagingRollbackCliOptions): Promise<StagingRollbackPlan> {
  const targetCommit = requireValue(options, 'target-commit');
  const currentDeployedCommit = requireValue(options, 'current-deployed-commit');
  const reviewedRef = options.values['reviewed-ref'] ?? 'origin/main';
  const references = evidenceReferences(options);
  const intent = rollbackIntent(options);
  const gitEvidence = collectStagingRollbackGitEvidence(
    repositoryRoot,
    targetCommit,
    reviewedRef,
    currentDeployedCommit,
  );
  assertLocalGitPreflight(gitEvidence);
  assertVerifiedStagingRuntime(process.env);
  const now = new Date();
  const currentDeploymentEvidence = options.command === 'preflight'
    ? await collectCurrentDeploymentEvidence({
      baseUrl: parseHostedSmokeBaseUrl(requireValue(options, 'base-url')),
      currentDeployedCommit,
      migrationsDirectory: path.join(repositoryRoot, 'infra/supabase/migrations'),
    })
    : {
      authority: 'NOT_PROVEN' as const,
      expectedCommit: currentDeployedCommit,
      observedCommit: 'UNAVAILABLE',
      smokeClassification: 'NOT_RUN',
    };
  if (options.command === 'preflight'
    && (currentDeploymentEvidence.observedCommit !== currentDeployedCommit
      || currentDeploymentEvidence.smokeClassification !== 'READY_FOR_SUPERVISED_UAT')) {
    throw new StagingRollbackInputError('CURRENT_DEPLOYMENT_IDENTITY_MISMATCH');
  }
  const database = options.command === 'local-preflight'
    ? loadLocalUnprovenEvidence(options, gitEvidence, now)
    : collectDirectHostedDatabaseEvidence(gitEvidence, now);

  return prepareStagingApplicationRollback({
    intent,
    targetCommit,
    currentDeployedCommit,
    reviewedRef,
    repositoryRoot,
    gitEvidence,
    databaseSentinel: database.sentinel,
    gate4EvidenceBytes: database.bytes,
    gate4Evidence: database.evidence,
    databaseEvidenceAuthority: options.command === 'preflight'
      ? 'DIRECT_HOSTED_READ_ONLY'
      : 'NOT_PROVEN',
    currentDeploymentEvidence,
    evidenceReferences: references,
    authorize: options.authorize,
    confirmation: options.values.confirmation,
    now,
  });
}

function outputPreflight(plan: StagingRollbackPlan, json: boolean): number {
  if (json) printJson(plan);
  else process.stdout.write(`${formatStagingRollbackReport(plan)}\n`);
  return plan.classification === 'AUTHORIZED_FOR_MANUAL_PROVIDER_ACTION'
    ? 0
    : ['DRY_RUN_READY_AUTHORIZATION_REQUIRED',
      'LOCAL_EVIDENCE_MATCH_DATABASE_AUTHORITY_NOT_PROVEN'].includes(plan.classification)
      ? 2
      : 1;
}

async function runPostDeploy(options: StagingRollbackCliOptions): Promise<number> {
  if (options.authorize) throw new Error('POST_DEPLOY_AUTHORIZATION_INVALID');
  const plan = readBoundedJsonFile(
    requireValue(options, 'plan'),
    2 * 1024 * 1024,
  ).value as StagingRollbackPlan;
  const deploymentState = requireValue(options, 'deployment-state');
  if (!['succeeded', 'failed', 'interrupted'].includes(deploymentState)) {
    throw new Error('DEPLOYMENT_STATE_INVALID');
  }
  const deploymentReference = requireValue(options, 'deployment-reference');
  if (!validEvidenceReference(deploymentReference)) throw new Error('EVIDENCE_REFERENCE_INVALID');

  const initialEvidence = {
    formatVersion: STAGING_APPLICATION_POST_DEPLOY_FORMAT,
    planDigest: plan.planDigest,
    deploymentState: deploymentState as 'succeeded' | 'failed' | 'interrupted',
    deploymentReference,
  };
  let result = verifyStagingApplicationPostDeploy(plan, initialEvidence);
  if (deploymentState === 'succeeded'
    && result.classification !== 'POST_DEPLOY_EVIDENCE_INVALID') {
    const gitEvidence = collectStagingRollbackGitEvidence(
      repositoryRoot,
      plan.target.commit,
      plan.reviewedRef.name,
      plan.previousApplicationCommit,
    );
    assertLocalGitPreflight(gitEvidence);
    const now = new Date();
    const database = collectDirectHostedDatabaseEvidence(gitEvidence, now);
    const smoke = await runHostedSmokeVerifier({
      baseUrl: parseHostedSmokeBaseUrl(requireValue(options, 'base-url')),
      expectedCommit: plan.target.commit,
      migrationsDirectory: path.join(repositoryRoot, 'infra/supabase/migrations'),
    });
    result = verifyStagingApplicationPostDeploy(plan, {
      ...initialEvidence,
      observedCommit: smoke.deploymentCommit.state === 'valid'
        ? smoke.deploymentCommit.value
        : undefined,
      smokeClassification: smoke.classification,
      observedMigrationCount: database.sentinel.repositoryMigrationVersions.length,
      observedLatestMigration: database.sentinel.repositoryMigrationVersions.at(-1),
      gate4Classification: database.sentinel.gate4Classification,
      databaseAuthority: 'DIRECT_HOSTED_READ_ONLY',
      smokeAuthority: 'DIRECT_PUBLIC_GET_HEAD',
    });
  }

  if (options.json) printJson(result);
  else {
    process.stdout.write([
      'ADMIN/CMS STAGING APPLICATION POST-DEPLOY CHECK',
      `CLASSIFICATION = ${result.classification}`,
      `ACCEPTED = ${result.accepted ? 'YES' : 'NO'}`,
      `TECHNICAL_VERIFICATION = ${result.technicalVerificationPassed ? 'PASS' : 'FAIL'}`,
      'PRIOR_AUTHORIZATION_PROVEN = NO',
      `BLOCKERS = ${result.blockers.length === 0 ? 'NONE' : result.blockers.join(',')}`,
      'HOSTED_MUTATION_PERFORMED_BY_THIS_TOOL = NO',
      'DATABASE_MUTATION_PERFORMED = NO',
      'PUBLICATION_MUTATION_PERFORMED = NO',
      ...result.abortAndRecovery.map((step, index) => `ABORT_RECOVERY_${index + 1} = ${step}`),
    ].join('\n') + '\n');
  }
  return result.technicalVerificationPassed ? 2 : 1;
}

export async function runCheckStagingApplicationRollback(
  args = process.argv.slice(2),
): Promise<number> {
  try {
    const options = parseStagingRollbackCliArgs(args);
    if (options.command === 'post-deploy') return await runPostDeploy(options);
    return outputPreflight(await prepareFromOptions(options), options.json);
  } catch (error) {
    const code = error instanceof StagingRollbackInputError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'INPUT_INVALID';
    process.stdout.write([
      'ADMIN/CMS STAGING APPLICATION ROLLBACK CHECK',
      'CLASSIFICATION = PREFLIGHT_BLOCKED',
      `BLOCKERS = ${code}`,
      'HOSTED_MUTATION_PERFORMED = NO',
      'DATABASE_MUTATION_PERFORMED = NO',
      'PUBLICATION_MUTATION_PERFORMED = NO',
    ].join('\n') + '\n');
    return 1;
  }
}

if (require.main === module) {
  runCheckStagingApplicationRollback()
    .then((code) => { process.exitCode = code; })
    .catch(() => { process.exitCode = 1; });
}
