import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadRepositoryMigrationExpectation,
  parseHostedSmokeBaseUrl,
  runHostedSmokeVerifier,
  type HostedSmokeClassification,
  type HostedSmokeReport,
  type HostedSmokeRequestObservation,
  type RepositoryMigrationExpectation,
} from '../deployment/hostedDeploymentSmokeVerifier';
import {
  EXPECTED_REPOSITORY_MIGRATION_COUNT,
  EXPECTED_REPOSITORY_MIGRATIONS,
} from '../deployment/hostedDeploymentReadiness';
import {
  isVerifiedStagingRuntime,
  type StagingRuntimeEnvironment,
} from '../security/stagingRuntimeIdentity';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const repoRoot = path.resolve(__dirname, '../../../..');

export const M6_REQUIRED_DOCUMENTS = [
  { id: 'operational-readiness', path: 'docs/m6-operational-readiness.md' },
  { id: 'release-acceptance', path: 'docs/m6-release-acceptance-checklist.md' },
  { id: 'admin-operator-guide', path: 'docs/admin-operator-guide.md' },
  { id: 'developer-handover', path: 'docs/developer-handover-guide.md' },
  { id: 'ownership-training', path: 'docs/operational-handover-and-training.md' },
  { id: 'local-recovery', path: 'docs/system-recovery-readiness.md' },
  { id: 'hosted-deployment', path: 'docs/admin-cms-hosted-deployment.md' },
  { id: 'staging-reconciliation', path: 'infra/supabase/staging-reconciliation-runbook.md' },
] as const;

export const M6_RELEASE_CHECKLIST_SECTIONS = [
  '## Source',
  '## Database',
  '## Application',
  '## Core workflow',
  '## Security',
  '## Recovery',
  '## Monitoring',
  '## Documentation',
  '## Handover',
] as const;

type DocumentEvidence = {
  id: (typeof M6_REQUIRED_DOCUMENTS)[number]['id'];
  state: 'PRESENT' | 'MISSING';
};

type ChecklistEvidence = {
  templateState: 'PRESENT' | 'INCOMPLETE' | 'MISSING';
  evidenceState: 'NO_EVIDENCE_RECORDED' | 'PARTIAL' | 'ALL_ITEMS_MARKED' | 'UNAVAILABLE';
  checkedItems: number;
  totalItems: number;
};

type MigrationEvidence = RepositoryMigrationExpectation & {
  expectedCount: number;
  expectedLatest: string;
  manifestState: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE';
};

type SanitizedHostedSmokeEvidence = {
  state: 'NOT_RUN' | 'COMPLETED';
  classification?: HostedSmokeClassification;
  deploymentCommitState?: 'valid' | 'missing' | 'invalid' | 'unavailable';
  deploymentCommit?: string;
  expectedCommit?: string;
  repositoryMigrations?: RepositoryMigrationExpectation | null;
  observedMigrations?: RepositoryMigrationExpectation | null;
  requests?: HostedSmokeRequestObservation[];
};

export type M6OperationalReadinessClassification =
  | 'REPOSITORY_READY_HOSTED_CHECK_NOT_RUN'
  | 'READ_ONLY_HOSTED_CHECK_PASSED'
  | 'READ_ONLY_HOSTED_CHECK_FAILED'
  | 'REPOSITORY_EVIDENCE_INCOMPLETE';

export type M6OperationalReadinessReport = {
  schemaVersion: 'm6-operational-readiness/v1';
  classification: M6OperationalReadinessClassification;
  source: {
    branch: string;
    commit: string;
    expectedCommit: string;
    identityState: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE';
  };
  repositoryMigrations: MigrationEvidence;
  stagingTargetIdentity: 'VERIFIED' | 'NOT_CONFIGURED' | 'INVALID';
  documents: DocumentEvidence[];
  releaseChecklist: ChecklistEvidence;
  hostedSmoke: SanitizedHostedSmokeEvidence;
  hostedMutations: 'NONE';
};

type GitEvidence = { branch: string; commit: string };

type CollectM6OperationalReadinessOptions = {
  repositoryRoot?: string;
  expectedCommit?: string;
  baseUrl?: URL;
  env?: StagingRuntimeEnvironment;
  gitEvidence?: GitEvidence;
  hostedSmokeRunner?: (options: {
    baseUrl: URL;
    expectedCommit: string;
    migrationsDirectory: string;
  }) => Promise<HostedSmokeReport>;
};

export type M6OperationalReadinessCliOptions = {
  baseUrl?: URL;
  expectedCommit?: string;
  json: boolean;
};

export class M6OperationalReadinessInputError extends Error {
  constructor() {
    super('Invalid M6 operational readiness input.');
  }
}

function readGitValue(repositoryRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function loadGitEvidence(repositoryRoot: string): GitEvidence {
  const commit = readGitValue(repositoryRoot, ['rev-parse', 'HEAD']).toLowerCase();
  const branch = readGitValue(repositoryRoot, ['branch', '--show-current']);
  return {
    commit: SHA_PATTERN.test(commit) ? commit : 'UNAVAILABLE',
    branch: branch && SAFE_BRANCH_PATTERN.test(branch) ? branch : 'DETACHED_OR_UNAVAILABLE',
  };
}

function loadMigrationEvidence(repositoryRoot: string): MigrationEvidence {
  const migrationsDirectory = path.join(repositoryRoot, 'infra/supabase/migrations');
  const expectedLatest = EXPECTED_REPOSITORY_MIGRATIONS[
    EXPECTED_REPOSITORY_MIGRATIONS.length - 1
  ].replace(/\.sql$/, '');

  try {
    const expectation = loadRepositoryMigrationExpectation(migrationsDirectory);
    const files = fs.readdirSync(migrationsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
    const manifestMatches = files.length === EXPECTED_REPOSITORY_MIGRATIONS.length &&
      files.every((file, index) => file === EXPECTED_REPOSITORY_MIGRATIONS[index]);

    return {
      ...expectation,
      expectedCount: EXPECTED_REPOSITORY_MIGRATION_COUNT,
      expectedLatest,
      manifestState: manifestMatches &&
        expectation.count === EXPECTED_REPOSITORY_MIGRATION_COUNT &&
        expectation.latest === expectedLatest
        ? 'MATCH'
        : 'MISMATCH',
    };
  } catch {
    return {
      count: 0,
      latest: 'UNAVAILABLE',
      expectedCount: EXPECTED_REPOSITORY_MIGRATION_COUNT,
      expectedLatest,
      manifestState: 'UNAVAILABLE',
    };
  }
}

function loadDocumentEvidence(repositoryRoot: string): DocumentEvidence[] {
  return M6_REQUIRED_DOCUMENTS.map((document) => ({
    id: document.id,
    state: fs.existsSync(path.join(repositoryRoot, document.path)) ? 'PRESENT' : 'MISSING',
  }));
}

function loadChecklistEvidence(repositoryRoot: string): ChecklistEvidence {
  const checklistPath = path.join(repositoryRoot, 'docs/m6-release-acceptance-checklist.md');
  let markdown: string;
  try {
    markdown = fs.readFileSync(checklistPath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return {
      templateState: 'MISSING',
      evidenceState: 'UNAVAILABLE',
      checkedItems: 0,
      totalItems: 0,
    };
  }

  const boxes = [...markdown.matchAll(/^- \[([ xX])\] /gm)];
  const checkedItems = boxes.filter((match) => match[1].toLowerCase() === 'x').length;
  const totalItems = boxes.length;
  const requiredSectionsPresent = M6_RELEASE_CHECKLIST_SECTIONS.every((section) =>
    markdown.includes(section));
  const templateState = requiredSectionsPresent && totalItems > 0 ? 'PRESENT' : 'INCOMPLETE';
  const evidenceState = totalItems === 0
    ? 'UNAVAILABLE'
    : checkedItems === 0
      ? 'NO_EVIDENCE_RECORDED'
      : checkedItems === totalItems
        ? 'ALL_ITEMS_MARKED'
        : 'PARTIAL';

  return { templateState, evidenceState, checkedItems, totalItems };
}

function classifyStagingTargetIdentity(
  env: StagingRuntimeEnvironment,
): M6OperationalReadinessReport['stagingTargetIdentity'] {
  const relevantValues = [
    env.CAPSTONE_RUNTIME_ENV,
    env.CAPSTONE_EXPECTED_SUPABASE_HOST,
    env.NEXT_PUBLIC_SUPABASE_URL,
  ];
  if (relevantValues.every((value) => value === undefined || value === '')) {
    return 'NOT_CONFIGURED';
  }
  return isVerifiedStagingRuntime(env) ? 'VERIFIED' : 'INVALID';
}

function sanitizeHostedSmoke(report: HostedSmokeReport): SanitizedHostedSmokeEvidence {
  return {
    state: 'COMPLETED',
    classification: report.classification,
    deploymentCommitState: report.deploymentCommit.state,
    ...(report.deploymentCommit.state === 'valid'
      ? { deploymentCommit: report.deploymentCommit.value }
      : {}),
    ...(report.expectedCommit ? { expectedCommit: report.expectedCommit } : {}),
    repositoryMigrations: report.repositoryMigrations,
    observedMigrations: report.observedMigrations,
    requests: report.requests,
  };
}

export async function collectM6OperationalReadiness({
  repositoryRoot = repoRoot,
  expectedCommit,
  baseUrl,
  env = process.env,
  gitEvidence = loadGitEvidence(repositoryRoot),
  hostedSmokeRunner = runHostedSmokeVerifier,
}: CollectM6OperationalReadinessOptions = {}): Promise<M6OperationalReadinessReport> {
  const commit = SHA_PATTERN.test(gitEvidence.commit) ? gitEvidence.commit.toLowerCase() : 'UNAVAILABLE';
  const normalizedExpectedCommit = expectedCommit?.toLowerCase() ?? commit;
  const identityState = commit === 'UNAVAILABLE' || !SHA_PATTERN.test(normalizedExpectedCommit)
    ? 'UNAVAILABLE'
    : commit === normalizedExpectedCommit
      ? 'MATCH'
      : 'MISMATCH';
  const branch = SAFE_BRANCH_PATTERN.test(gitEvidence.branch)
    ? gitEvidence.branch
    : 'DETACHED_OR_UNAVAILABLE';
  const repositoryMigrations = loadMigrationEvidence(repositoryRoot);
  const documents = loadDocumentEvidence(repositoryRoot);
  const releaseChecklist = loadChecklistEvidence(repositoryRoot);
  const stagingTargetIdentity = classifyStagingTargetIdentity(env);

  let hostedSmoke: SanitizedHostedSmokeEvidence = { state: 'NOT_RUN' };
  if (baseUrl && SHA_PATTERN.test(normalizedExpectedCommit)) {
    try {
      const report = await hostedSmokeRunner({
        baseUrl,
        expectedCommit: normalizedExpectedCommit,
        migrationsDirectory: path.join(repositoryRoot, 'infra/supabase/migrations'),
      });
      hostedSmoke = sanitizeHostedSmoke(report);
    } catch {
      hostedSmoke = {
        state: 'COMPLETED',
        classification: 'NETWORK_FAILED',
        expectedCommit: normalizedExpectedCommit,
        requests: [],
      };
    }
  }

  const repositoryReady = identityState === 'MATCH' &&
    repositoryMigrations.manifestState === 'MATCH' &&
    documents.every((document) => document.state === 'PRESENT') &&
    releaseChecklist.templateState === 'PRESENT' &&
    stagingTargetIdentity !== 'INVALID';

  let classification: M6OperationalReadinessClassification;
  if (!repositoryReady) {
    classification = 'REPOSITORY_EVIDENCE_INCOMPLETE';
  } else if (hostedSmoke.state === 'NOT_RUN') {
    classification = 'REPOSITORY_READY_HOSTED_CHECK_NOT_RUN';
  } else if (hostedSmoke.classification === 'READY_FOR_SUPERVISED_UAT') {
    classification = 'READ_ONLY_HOSTED_CHECK_PASSED';
  } else {
    classification = 'READ_ONLY_HOSTED_CHECK_FAILED';
  }

  return {
    schemaVersion: 'm6-operational-readiness/v1',
    classification,
    source: {
      branch,
      commit,
      expectedCommit: SHA_PATTERN.test(normalizedExpectedCommit)
        ? normalizedExpectedCommit
        : 'UNAVAILABLE',
      identityState,
    },
    repositoryMigrations,
    stagingTargetIdentity,
    documents,
    releaseChecklist,
    hostedSmoke,
    hostedMutations: 'NONE',
  };
}

export function parseM6OperationalReadinessCliArgs(
  args: string[],
): M6OperationalReadinessCliOptions {
  let baseUrl: URL | undefined;
  let expectedCommit: string | undefined;
  let json = false;

  for (const arg of args) {
    if (arg === '--json') {
      if (json) throw new M6OperationalReadinessInputError();
      json = true;
    } else if (arg.startsWith('--base-url=')) {
      if (baseUrl) throw new M6OperationalReadinessInputError();
      try {
        baseUrl = parseHostedSmokeBaseUrl(arg.slice('--base-url='.length));
      } catch {
        throw new M6OperationalReadinessInputError();
      }
    } else if (arg.startsWith('--expected-commit=')) {
      if (expectedCommit) throw new M6OperationalReadinessInputError();
      const value = arg.slice('--expected-commit='.length);
      if (!SHA_PATTERN.test(value)) throw new M6OperationalReadinessInputError();
      expectedCommit = value.toLowerCase();
    } else {
      throw new M6OperationalReadinessInputError();
    }
  }

  return { baseUrl, expectedCommit, json };
}

export function formatM6OperationalReadinessReport(
  report: M6OperationalReadinessReport,
): string {
  const lines = [
    'M6 OPERATIONAL READINESS EVIDENCE (READ-ONLY)',
    `SOURCE_BRANCH = ${report.source.branch}`,
    `SOURCE_COMMIT = ${report.source.commit}`,
    `EXPECTED_COMMIT = ${report.source.expectedCommit}`,
    `SOURCE_IDENTITY = ${report.source.identityState}`,
    `REPOSITORY_MIGRATIONS = count=${report.repositoryMigrations.count} latest=${report.repositoryMigrations.latest}`,
    `MIGRATION_MANIFEST = ${report.repositoryMigrations.manifestState}`,
    `STAGING_TARGET_IDENTITY = ${report.stagingTargetIdentity}`,
  ];

  for (const document of report.documents) {
    lines.push(`DOCUMENT ${document.id} = ${document.state}`);
  }
  lines.push(`RELEASE_CHECKLIST_TEMPLATE = ${report.releaseChecklist.templateState}`);
  lines.push(
    `RELEASE_EVIDENCE = ${report.releaseChecklist.evidenceState} ` +
    `checked=${report.releaseChecklist.checkedItems} total=${report.releaseChecklist.totalItems}`,
  );
  lines.push(`HOSTED_SMOKE = ${report.hostedSmoke.state === 'NOT_RUN'
    ? 'NOT_RUN'
    : report.hostedSmoke.classification}`);

  for (const request of report.hostedSmoke.requests ?? []) {
    lines.push(
      `HOSTED_REQUEST ${request.method} ${request.endpoint} status=${request.status ?? 'UNAVAILABLE'} ` +
      `duration_ms=${request.durationMs} result=${request.outcome} detail=${request.detail}`,
    );
  }
  lines.push(`HOSTED_MUTATIONS = ${report.hostedMutations}`);
  lines.push(`M6_OPERATIONAL_READINESS_CLASSIFICATION = ${report.classification}`);
  return lines.join('\n');
}

export function formatInvalidM6OperationalReadinessInput(): string {
  return [
    'M6 OPERATIONAL READINESS EVIDENCE (READ-ONLY)',
    'USAGE = [--base-url=https://host.example] [--expected-commit=<40-hex-sha>] [--json]',
    'HOSTED_MUTATIONS = NONE',
    'M6_OPERATIONAL_READINESS_CLASSIFICATION = INVALID_INPUT',
  ].join('\n');
}
