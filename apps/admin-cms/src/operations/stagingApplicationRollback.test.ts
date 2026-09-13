import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../deployment/gate4SchemaEvidence', () => ({
  parseGate4Evidence: (input: unknown) => {
    const migrations = (input as { migrations?: unknown } | null)?.migrations;
    return Array.isArray(migrations)
      ? { ok: true, evidence: input }
      : { ok: false, errors: ['invalid'] };
  },
  validateCurrentRepositoryGate4Contract: () => [],
}));

import {
  collectStagingRollbackGitEvidence,
  collectCurrentDeploymentEvidence,
  createStagingDatabaseSentinel,
  DATABASE_SENTINEL_MAX_AGE_MS,
  prepareStagingApplicationRollback,
  STAGING_APPLICATION_POST_DEPLOY_FORMAT,
  STAGING_DATABASE_SENTINEL_FORMAT,
  StagingRollbackInputError,
  verifyStagingApplicationPostDeploy,
  type PrepareStagingRollbackOptions,
  type StagingDatabaseSentinel,
  type StagingRollbackGitEvidence,
} from './stagingApplicationRollback';

const TARGET = 'a'.repeat(40);
const CURRENT_REPOSITORY = 'c'.repeat(40);
const CURRENT_DEPLOYMENT = 'd'.repeat(40);
const REVIEWED_HEAD = CURRENT_REPOSITORY;
const MIGRATIONS = ['20260101000000', '20260202000000'];
const NOW = new Date('2026-09-09T12:00:00.000Z');
const GATE4_BYTES = Buffer.from(JSON.stringify({ migrations: MIGRATIONS }));
const GATE4_EVIDENCE = { migrations: MIGRATIONS };

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitEvidence(overrides: Partial<StagingRollbackGitEvidence> = {}): StagingRollbackGitEvidence {
  return {
    currentCommit: CURRENT_REPOSITORY,
    currentTree: '1'.repeat(40),
    currentBranch: 'main',
    trackedCheckoutClean: true,
    reviewedRef: 'origin/main',
    reviewedRefCommit: REVIEWED_HEAD,
    currentDeployedCommit: CURRENT_DEPLOYMENT,
    currentDeployedReachableFromReviewedRef: true,
    targetCommit: TARGET,
    targetReachableFromReviewedRef: true,
    targetTree: '2'.repeat(40),
    targetApplicationTree: '3'.repeat(40),
    targetLockfileObject: '4'.repeat(40),
    targetMigrationTree: '5'.repeat(40),
    currentMigrationTree: '5'.repeat(40),
    targetDatabaseContractObject: '6'.repeat(40),
    currentDatabaseContractObject: '6'.repeat(40),
    currentMigrationVersions: MIGRATIONS,
    targetMigrationVersions: MIGRATIONS,
    ...overrides,
  };
}

function sentinel(overrides: Partial<StagingDatabaseSentinel> = {}): StagingDatabaseSentinel {
  return {
    formatVersion: STAGING_DATABASE_SENTINEL_FORMAT,
    environment: 'staging',
    supabaseHost: 'staging.supabase.co',
    observedAt: '2026-09-09T11:59:00.000Z',
    repositoryGitSha: CURRENT_REPOSITORY,
    repositoryMigrationVersions: MIGRATIONS,
    migrationTreeObject: '5'.repeat(40),
    databaseContractObject: '6'.repeat(40),
    gate4EvidenceSha256: digest(GATE4_BYTES),
    gate4Classification: 'GATE4_MATCH',
    provenance: 'DIRECT_HOSTED_READ_ONLY',
    ...overrides,
  };
}

const env = {
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging.supabase.co',
  NEXT_PUBLIC_SUPABASE_URL: 'https://staging.supabase.co',
  CAPSTONE_STAGING_MUTATION_CONFIRMATION: 'capstone-staging',
};

function options(overrides: Partial<PrepareStagingRollbackOptions> = {}): PrepareStagingRollbackOptions {
  return {
    intent: 'rollback',
    targetCommit: TARGET,
    currentDeployedCommit: CURRENT_DEPLOYMENT,
    repositoryRoot: path.resolve(__dirname, '../../../..'),
    gitEvidence: gitEvidence(),
    databaseSentinel: sentinel(),
    gate4EvidenceBytes: GATE4_BYTES,
    gate4Evidence: GATE4_EVIDENCE,
    databaseEvidenceAuthority: 'DIRECT_HOSTED_READ_ONLY',
    currentDeploymentEvidence: {
      authority: 'DIRECT_PUBLIC_GET_HEAD',
      expectedCommit: CURRENT_DEPLOYMENT,
      observedCommit: CURRENT_DEPLOYMENT,
      smokeClassification: 'READY_FOR_SUPERVISED_UAT',
    },
    evidenceReferences: {
      change: 'change-2026-09-09',
      reviewApproval: 'review-approved-123',
      ci: 'ci-passed-123',
      priorDeployment: 'deployment-123',
      priorSmoke: 'smoke-ready-123',
      deploymentCredential: 'credential-check-123',
    },
    env,
    now: NOW,
    ...overrides,
  };
}

function authorizedPlan() {
  return prepareStagingApplicationRollback(options({
    authorize: true,
    confirmation: `capstone-staging:rollback:${TARGET}`,
  }));
}

describe('staging application rollback immutable source preflight', () => {
  it('collects current deployment identity through an injected credential-free smoke verifier', async () => {
    const smokeRunner = vi.fn(async () => ({
      classification: 'READY_FOR_SUPERVISED_UAT',
      deploymentCommit: { state: 'valid', value: CURRENT_DEPLOYMENT },
    } as never));
    const evidence = await collectCurrentDeploymentEvidence({
      baseUrl: new URL('https://staging.example'),
      currentDeployedCommit: CURRENT_DEPLOYMENT,
      migrationsDirectory: 'migrations',
      smokeRunner,
    });

    expect(smokeRunner).toHaveBeenCalledWith(expect.objectContaining({
      expectedCommit: CURRENT_DEPLOYMENT,
    }));
    expect(evidence).toEqual({
      authority: 'DIRECT_PUBLIC_GET_HEAD',
      expectedCommit: CURRENT_DEPLOYMENT,
      observedCommit: CURRENT_DEPLOYMENT,
      smokeClassification: 'READY_FOR_SUPERVISED_UAT',
    });
  });

  it('creates a fresh staging sentinel only from checksum-bound matching Gate 4 evidence', () => {
    const created = createStagingDatabaseSentinel({
      repositoryRoot: path.resolve(__dirname, '../../../..'),
      gitEvidence: gitEvidence(),
      gate4EvidenceBytes: GATE4_BYTES,
      gate4Evidence: GATE4_EVIDENCE,
      gate4Attestation: {
        classification: 'GATE4_MATCH',
        repositoryGitSha: CURRENT_REPOSITORY,
        actualEvidenceSha256: digest(GATE4_BYTES),
        totalDifferences: 0,
        differences: [],
        validationErrors: [],
      },
      observedAt: '2026-09-09T11:59:00.000Z',
      provenance: 'DIRECT_HOSTED_READ_ONLY',
      env,
      now: NOW,
    });

    expect(created).toMatchObject({
      repositoryMigrationVersions: MIGRATIONS,
      migrationTreeObject: '5'.repeat(40),
      databaseContractObject: '6'.repeat(40),
      gate4EvidenceSha256: digest(GATE4_BYTES),
    });
    expect(() => createStagingDatabaseSentinel({
      repositoryRoot: path.resolve(__dirname, '../../../..'),
      gitEvidence: gitEvidence(),
      gate4EvidenceBytes: GATE4_BYTES,
      gate4Evidence: GATE4_EVIDENCE,
      gate4Attestation: {
        classification: 'GATE4_MATCH',
        repositoryGitSha: CURRENT_REPOSITORY,
        actualEvidenceSha256: 'f'.repeat(64),
        totalDifferences: 0,
        differences: [],
        validationErrors: [],
      },
      observedAt: '2026-09-09T11:59:00.000Z',
      provenance: 'DIRECT_HOSTED_READ_ONLY',
      env,
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'DATABASE_SENTINEL_INVALID' }));
  });

  it('produces deterministic dry-run evidence and withholds hosted mutation authorization', () => {
    const first = prepareStagingApplicationRollback(options());
    const second = prepareStagingApplicationRollback(options());

    expect(first.classification).toBe('DRY_RUN_READY_AUTHORIZATION_REQUIRED');
    expect(first.blockers).toEqual(['OPERATOR_AUTHORIZATION_REQUIRED']);
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.target.sourceArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.target).toMatchObject({
      commit: TARGET,
      tree: '2'.repeat(40),
      applicationTree: '3'.repeat(40),
      lockfileObject: '4'.repeat(40),
      migrationTree: '5'.repeat(40),
    });
    expect(first.hostedMutationPerformed).toBe(false);
    expect(first.databaseMutationPerformed).toBe(false);
    expect(first.publicationMutationPerformed).toBe(false);
  });

  it('never treats operator-supplied file evidence as hosted database authority', () => {
    const dryRun = prepareStagingApplicationRollback(options({
      databaseEvidenceAuthority: 'NOT_PROVEN',
      currentDeploymentEvidence: {
        authority: 'NOT_PROVEN',
        expectedCommit: CURRENT_DEPLOYMENT,
        observedCommit: 'UNAVAILABLE',
        smokeClassification: 'NOT_RUN',
      },
      databaseSentinel: sentinel({
        provenance: 'UNAUTHENTICATED_FILE_INPUT_NOT_HOSTED_AUTHORITY',
      }),
    }));
    const attemptedAuthorization = prepareStagingApplicationRollback(options({
      databaseEvidenceAuthority: 'NOT_PROVEN',
      currentDeploymentEvidence: {
        authority: 'NOT_PROVEN',
        expectedCommit: CURRENT_DEPLOYMENT,
        observedCommit: 'UNAVAILABLE',
        smokeClassification: 'NOT_RUN',
      },
      databaseSentinel: sentinel({
        provenance: 'UNAUTHENTICATED_FILE_INPUT_NOT_HOSTED_AUTHORITY',
      }),
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(dryRun.classification).toBe('LOCAL_EVIDENCE_MATCH_DATABASE_AUTHORITY_NOT_PROVEN');
    expect(dryRun.blockers).toEqual([
      'DATABASE_AUTHORITY_NOT_PROVEN',
      'CURRENT_DEPLOYMENT_IDENTITY_NOT_PROVEN',
    ]);
    expect(attemptedAuthorization.classification).toBe('PREFLIGHT_BLOCKED');
    expect(attemptedAuthorization.blockers).toContain('DATABASE_AUTHORITY_NOT_PROVEN');
    expect(attemptedAuthorization.hostedMutationPerformed).toBe(false);
  });

  it('authorizes only the exact environment-bound, intent-bound, full-SHA confirmation', () => {
    const plan = authorizedPlan();

    expect(plan.classification).toBe('AUTHORIZED_FOR_MANUAL_PROVIDER_ACTION');
    expect(plan.authorization.state).toBe('AUTHORIZED');
    expect(plan.blockers).toEqual([]);
    expect(plan.hostedMutationPerformed).toBe(false);
  });

  it('rejects invalid and locally unreachable target commits before artifact inspection', () => {
    const root = path.resolve(__dirname, '../../../..');
    expect(() => collectStagingRollbackGitEvidence(root, 'short'))
      .toThrowError(expect.objectContaining<Partial<StagingRollbackInputError>>({ code: 'INVALID_TARGET_COMMIT' }));
    expect(() => collectStagingRollbackGitEvidence(root, 'f'.repeat(40)))
      .toThrowError(expect.objectContaining<Partial<StagingRollbackInputError>>({ code: 'TARGET_COMMIT_UNREACHABLE' }));
  });

  it('gives production background flags no historical staging rollback authority', () => {
    const plan = prepareStagingApplicationRollback(options({
      env: {
        ...env,
        CAPSTONE_RUNTIME_ENV: 'production',
        CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: 'true',
        CAPSTONE_PRODUCTION_REMINDERS_ENABLED: 'true',
        CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT: 'production-reminders-approved',
      },
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(plan.classification).toBe('PREFLIGHT_BLOCKED');
    expect(plan.blockers).toContain('STAGING_CONFIGURATION_INVALID');
    expect(plan.hostedMutationPerformed).toBe(false);
    expect(plan.databaseMutationPerformed).toBe(false);
  });

  it.each([
    ['dirty tracked checkout', { trackedCheckoutClean: false }, 'TRACKED_CHECKOUT_DIRTY'],
    ['unreviewed target artifact', { targetReachableFromReviewedRef: false }, 'TARGET_COMMIT_NOT_REVIEWED'],
    ['clean unreviewed tooling checkout', { reviewedRefCommit: 'e'.repeat(40) }, 'TOOLING_COMMIT_NOT_REVIEWED_HEAD'],
  ])('blocks a %s', (_name, gitOverrides, blocker) => {
    const plan = prepareStagingApplicationRollback(options({
      gitEvidence: gitEvidence(gitOverrides),
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(plan.classification).toBe('PREFLIGHT_BLOCKED');
    expect(plan.blockers).toContain(blocker);
    expect(plan.hostedMutationPerformed).toBe(false);
  });

  it('rejects missing, invalid, or mismatched fresh current-deployment identity', () => {
    const unproven = prepareStagingApplicationRollback(options({
      currentDeploymentEvidence: {
        authority: 'NOT_PROVEN',
        expectedCommit: CURRENT_DEPLOYMENT,
        observedCommit: CURRENT_DEPLOYMENT,
        smokeClassification: 'READY_FOR_SUPERVISED_UAT',
      },
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));
    const mismatched = prepareStagingApplicationRollback(options({
      currentDeploymentEvidence: {
        authority: 'DIRECT_PUBLIC_GET_HEAD',
        expectedCommit: CURRENT_DEPLOYMENT,
        observedCommit: TARGET,
        smokeClassification: 'DEPLOYMENT_COMMIT_MISMATCH',
      },
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(unproven.blockers).toContain('CURRENT_DEPLOYMENT_IDENTITY_NOT_PROVEN');
    expect(mismatched.blockers).toContain('CURRENT_DEPLOYMENT_IDENTITY_MISMATCH');
    expect(unproven.hostedMutationPerformed).toBe(false);
    expect(mismatched.hostedMutationPerformed).toBe(false);
  });

  it('rejects a stale database sentinel', () => {
    const plan = prepareStagingApplicationRollback(options({
      databaseSentinel: sentinel({
        observedAt: new Date(NOW.getTime() - DATABASE_SENTINEL_MAX_AGE_MS - 1).toISOString(),
      }),
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(plan.classification).toBe('PREFLIGHT_BLOCKED');
    expect(plan.blockers).toContain('DATABASE_SENTINEL_STALE');
  });

  it('requires database forward-recovery when the manifest or capability contract advanced', () => {
    const pendingMigration = '20260303000000';
    const plan = prepareStagingApplicationRollback(options({
      gitEvidence: gitEvidence({
        currentMigrationVersions: [...MIGRATIONS, pendingMigration],
        targetMigrationVersions: MIGRATIONS,
        currentDatabaseContractObject: '7'.repeat(40),
      }),
      databaseSentinel: sentinel({
        repositoryMigrationVersions: [...MIGRATIONS, pendingMigration],
        databaseContractObject: '7'.repeat(40),
      }),
      gate4Evidence: { migrations: [...MIGRATIONS, pendingMigration] },
      gate4EvidenceBytes: Buffer.from(JSON.stringify({ migrations: [...MIGRATIONS, pendingMigration] })),
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(plan.classification)
      .toBe('APPLICATION_ROLLBACK_REFUSED_DATABASE_FORWARD_RECOVERY_REQUIRED');
    expect(plan.blockers).toContain('DATABASE_MIGRATION_INCOMPATIBLE');
    expect(plan.blockers).toContain('DATABASE_CAPABILITY_CONTRACT_INCOMPATIBLE');
    expect(plan.database.recoveryPolicy).toBe('FORWARD_ONLY_NO_IN_PLACE_DOWNGRADE');
    expect(plan.abortAndRecovery.join(' ')).toContain('forward-recover');
  });

  it('blocks missing deployment credential evidence and missing target configuration', () => {
    const missingCredential = prepareStagingApplicationRollback(options({
      evidenceReferences: { ...options().evidenceReferences, deploymentCredential: '' },
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));
    const missingConfiguration = prepareStagingApplicationRollback(options({
      env: {},
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(missingCredential.blockers).toContain('DEPLOYMENT_CREDENTIAL_EVIDENCE_MISSING');
    expect(missingConfiguration.blockers).toContain('STAGING_CONFIGURATION_INVALID');
    expect(missingCredential.hostedMutationPerformed).toBe(false);
    expect(missingConfiguration.hostedMutationPerformed).toBe(false);
  });

  it('fails before mutation when Gate 4 evidence no longer matches its sentinel checksum', () => {
    const plan = prepareStagingApplicationRollback(options({
      gate4EvidenceBytes: Buffer.from('{"migrations":["tampered"]}'),
      authorize: true,
      confirmation: `capstone-staging:rollback:${TARGET}`,
    }));

    expect(plan.blockers).toContain('DATABASE_SENTINEL_EVIDENCE_MISMATCH');
    expect(plan.hostedMutationPerformed).toBe(false);
    expect(plan.databaseMutationPerformed).toBe(false);
    expect(plan.publicationMutationPerformed).toBe(false);
  });
});

describe('staging application rollback post-deploy recovery states', () => {
  it('classifies an interrupted deployment and preserves an exact recovery commit', () => {
    const plan = authorizedPlan();
    const result = verifyStagingApplicationPostDeploy(plan, {
      formatVersion: STAGING_APPLICATION_POST_DEPLOY_FORMAT,
      planDigest: plan.planDigest,
      deploymentState: 'interrupted',
      deploymentReference: 'deployment-124',
    });

    expect(result.classification).toBe('DEPLOYMENT_INTERRUPTED');
    expect(result.accepted).toBe(false);
    expect(result.abortAndRecovery.join(' ')).toContain(CURRENT_DEPLOYMENT);
    expect(result.abortAndRecovery.join(' ')).toContain('Keep staff mutation access blocked');
  });

  it('rejects a post-deploy readiness/identity mismatch with explicit abort guidance', () => {
    const plan = authorizedPlan();
    const result = verifyStagingApplicationPostDeploy(plan, {
      formatVersion: STAGING_APPLICATION_POST_DEPLOY_FORMAT,
      planDigest: plan.planDigest,
      deploymentState: 'succeeded',
      deploymentReference: 'deployment-125',
      observedCommit: CURRENT_DEPLOYMENT,
      smokeClassification: 'DEPLOYMENT_COMMIT_MISMATCH',
      observedMigrationCount: MIGRATIONS.length,
      observedLatestMigration: MIGRATIONS.at(-1),
      gate4Classification: 'GATE4_MATCH',
      databaseAuthority: 'DIRECT_HOSTED_READ_ONLY',
      smokeAuthority: 'DIRECT_PUBLIC_GET_HEAD',
    });

    expect(result.classification).toBe('POST_DEPLOY_READINESS_MISMATCH');
    expect(result.blockers).toContain('DEPLOYMENT_COMMIT_MISMATCH');
    expect(result.blockers).toContain('READINESS_OR_SMOKE_MISMATCH');
    expect(result.abortAndRecovery.join(' ')).toContain('Do not change, downgrade, repair, restore, or delete');
    expect(result.publicationMutationPerformed).toBe(false);
  });

  it('accepts only exact-SHA smoke, manifest, and fresh Gate 4 post-deploy evidence', () => {
    const plan = authorizedPlan();
    const result = verifyStagingApplicationPostDeploy(plan, {
      formatVersion: STAGING_APPLICATION_POST_DEPLOY_FORMAT,
      planDigest: plan.planDigest,
      deploymentState: 'succeeded',
      deploymentReference: 'deployment-126',
      observedCommit: TARGET,
      smokeClassification: 'READY_FOR_SUPERVISED_UAT',
      observedMigrationCount: MIGRATIONS.length,
      observedLatestMigration: MIGRATIONS.at(-1),
      gate4Classification: 'GATE4_MATCH',
      databaseAuthority: 'DIRECT_HOSTED_READ_ONLY',
      smokeAuthority: 'DIRECT_PUBLIC_GET_HEAD',
    });

    expect(result).toMatchObject({
      classification: 'POST_DEPLOY_TECHNICALLY_VERIFIED_AUTHORIZATION_NOT_PROVEN',
      accepted: false,
      technicalVerificationPassed: true,
      priorAuthorizationProven: false,
    });
  });

  it('never turns a forged but self-consistently rehashed plan into authorization proof', () => {
    const original = authorizedPlan();
    const { planDigest: _oldDigest, ...forgedBody } = {
      ...original,
      evidenceReferences: { ...original.evidenceReferences, change: 'forged-change-ref' },
    };
    expect(_oldDigest).toBe(original.planDigest);
    const forged = {
      ...forgedBody,
      planDigest: `sha256:${digest(Buffer.from(JSON.stringify(forgedBody)))}`,
    };
    const result = verifyStagingApplicationPostDeploy(forged, {
      formatVersion: STAGING_APPLICATION_POST_DEPLOY_FORMAT,
      planDigest: forged.planDigest,
      deploymentState: 'succeeded',
      deploymentReference: 'deployment-128',
      observedCommit: TARGET,
      smokeClassification: 'READY_FOR_SUPERVISED_UAT',
      observedMigrationCount: MIGRATIONS.length,
      observedLatestMigration: MIGRATIONS.at(-1),
      gate4Classification: 'GATE4_MATCH',
      databaseAuthority: 'DIRECT_HOSTED_READ_ONLY',
      smokeAuthority: 'DIRECT_PUBLIC_GET_HEAD',
    });

    expect(result.technicalVerificationPassed).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.priorAuthorizationProven).toBe(false);
    expect(result.classification)
      .toBe('POST_DEPLOY_TECHNICALLY_VERIFIED_AUTHORIZATION_NOT_PROVEN');
  });

  it('rejects a tampered authorized plan before interpreting deployment evidence', () => {
    const plan = { ...authorizedPlan(), previousApplicationCommit: 'f'.repeat(40) };
    const result = verifyStagingApplicationPostDeploy(plan, {
      formatVersion: STAGING_APPLICATION_POST_DEPLOY_FORMAT,
      planDigest: plan.planDigest,
      deploymentState: 'succeeded',
      deploymentReference: 'deployment-127',
      observedCommit: TARGET,
      smokeClassification: 'READY_FOR_SUPERVISED_UAT',
      observedMigrationCount: MIGRATIONS.length,
      observedLatestMigration: MIGRATIONS.at(-1),
      gate4Classification: 'GATE4_MATCH',
      databaseAuthority: 'DIRECT_HOSTED_READ_ONLY',
      smokeAuthority: 'DIRECT_PUBLIC_GET_HEAD',
    });

    expect(result.classification).toBe('POST_DEPLOY_EVIDENCE_INVALID');
    expect(result.accepted).toBe(false);
  });
});
