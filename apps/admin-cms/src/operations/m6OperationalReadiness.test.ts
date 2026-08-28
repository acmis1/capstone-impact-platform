import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostedSmokeReport } from '../deployment/hostedDeploymentSmokeVerifier';
import { EXPECTED_REPOSITORY_MIGRATIONS } from '../deployment/hostedDeploymentReadiness';
import {
  collectM6OperationalReadiness,
  formatM6OperationalReadinessReport,
  M6OperationalReadinessInputError,
  M6_RELEASE_CHECKLIST_SECTIONS,
  M6_REQUIRED_DOCUMENTS,
  parseM6OperationalReadinessCliArgs,
} from './m6OperationalReadiness';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = '89abcdef0123456789abcdef0123456789abcdef';
const temporaryRoots: string[] = [];

function createRepositoryFixture(options: {
  missingDocument?: string;
  migrations?: string[];
  checkedChecklistItems?: number;
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-readiness-'));
  temporaryRoots.push(root);
  const migrations = options.migrations ?? [...EXPECTED_REPOSITORY_MIGRATIONS];
  const migrationsDirectory = path.join(root, 'infra/supabase/migrations');
  fs.mkdirSync(migrationsDirectory, { recursive: true });
  for (const migration of migrations) {
    fs.writeFileSync(path.join(migrationsDirectory, migration), '-- synthetic test migration\n');
  }

  for (const document of M6_REQUIRED_DOCUMENTS) {
    if (document.path === options.missingDocument) continue;
    const documentPath = path.join(root, document.path);
    fs.mkdirSync(path.dirname(documentPath), { recursive: true });
    if (document.id === 'release-acceptance') {
      const checkedItems = options.checkedChecklistItems ?? 0;
      fs.writeFileSync(documentPath, [
        '# M6 Release Acceptance Checklist',
        ...M6_RELEASE_CHECKLIST_SECTIONS.flatMap((section, index) => [
          section,
          `- [${index < checkedItems ? 'x' : ' '}] Evidence item ${index + 1}`,
        ]),
      ].join('\n'));
    } else {
      fs.writeFileSync(documentPath, `# ${document.id}\n`);
    }
  }
  return root;
}

function readyHostedSmoke(): HostedSmokeReport {
  return {
    baseHost: 'private-staging.example',
    classification: 'READY_FOR_SUPERVISED_UAT',
    deploymentCommit: { state: 'valid', value: COMMIT },
    expectedCommit: COMMIT,
    repositoryMigrations: {
      count: EXPECTED_REPOSITORY_MIGRATIONS.length,
      latest: EXPECTED_REPOSITORY_MIGRATIONS.at(-1)!.replace(/\.sql$/, ''),
    },
    observedMigrations: {
      count: EXPECTED_REPOSITORY_MIGRATIONS.length,
      latest: EXPECTED_REPOSITORY_MIGRATIONS.at(-1)!.replace(/\.sql$/, ''),
    },
    requests: [],
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('M6 operational readiness repository evidence', () => {
  it('reports a complete repository package without claiming hosted evidence', async () => {
    const repositoryRoot = createRepositoryFixture();
    const report = await collectM6OperationalReadiness({
      repositoryRoot,
      gitEvidence: { branch: 'infra/m6-operational-readiness', commit: COMMIT },
      env: {},
    });

    expect(report.classification).toBe('REPOSITORY_READY_HOSTED_CHECK_NOT_RUN');
    expect(report.repositoryMigrations).toMatchObject({
      count: EXPECTED_REPOSITORY_MIGRATIONS.length,
      manifestState: 'MATCH',
    });
    expect(report.documents.every(({ state }) => state === 'PRESENT')).toBe(true);
    expect(report.releaseChecklist).toMatchObject({
      templateState: 'PRESENT',
      evidenceState: 'NO_EVIDENCE_RECORDED',
    });
    expect(report.hostedSmoke).toEqual({ state: 'NOT_RUN' });
    expect(report.hostedMutations).toBe('NONE');
  });

  it('fails closed when a required document or migration is absent', async () => {
    const repositoryRoot = createRepositoryFixture({
      missingDocument: 'docs/admin-operator-guide.md',
      migrations: EXPECTED_REPOSITORY_MIGRATIONS.slice(0, -1),
    });
    const report = await collectM6OperationalReadiness({
      repositoryRoot,
      gitEvidence: { branch: 'infra/m6-operational-readiness', commit: COMMIT },
      env: {},
    });

    expect(report.classification).toBe('REPOSITORY_EVIDENCE_INCOMPLETE');
    expect(report.repositoryMigrations.manifestState).toBe('MISMATCH');
    expect(report.documents).toContainEqual({ id: 'admin-operator-guide', state: 'MISSING' });
  });

  it('distinguishes a reviewed commit mismatch', async () => {
    const report = await collectM6OperationalReadiness({
      repositoryRoot: createRepositoryFixture(),
      expectedCommit: OTHER_COMMIT,
      gitEvidence: { branch: 'infra/m6-operational-readiness', commit: COMMIT },
      env: {},
    });

    expect(report.source.identityState).toBe('MISMATCH');
    expect(report.classification).toBe('REPOSITORY_EVIDENCE_INCOMPLETE');
  });

  it('classifies staging identity without emitting any environment value', async () => {
    const report = await collectM6OperationalReadiness({
      repositoryRoot: createRepositoryFixture(),
      gitEvidence: { branch: 'infra/m6-operational-readiness', commit: COMMIT },
      env: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging.example',
        NEXT_PUBLIC_SUPABASE_URL: 'https://staging.example',
      },
    });
    const serialized = JSON.stringify(report);

    expect(report.stagingTargetIdentity).toBe('VERIFIED');
    expect(serialized).not.toContain('staging.example');
  });

  it('fails closed on a partially configured staging identity', async () => {
    const report = await collectM6OperationalReadiness({
      repositoryRoot: createRepositoryFixture(),
      gitEvidence: { branch: 'infra/m6-operational-readiness', commit: COMMIT },
      env: {
        CAPSTONE_RUNTIME_ENV: 'staging',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging.example',
      },
    });

    expect(report.stagingTargetIdentity).toBe('INVALID');
    expect(report.classification).toBe('REPOSITORY_EVIDENCE_INCOMPLETE');
  });

  it('sanitizes a successful hosted check while preserving bounded evidence', async () => {
    const report = await collectM6OperationalReadiness({
      repositoryRoot: createRepositoryFixture({ checkedChecklistItems: 1 }),
      baseUrl: new URL('https://private-staging.example'),
      gitEvidence: { branch: 'infra/m6-operational-readiness', commit: COMMIT },
      env: {},
      hostedSmokeRunner: async () => readyHostedSmoke(),
    });
    const serialized = JSON.stringify(report);

    expect(report.classification).toBe('READ_ONLY_HOSTED_CHECK_PASSED');
    expect(report.releaseChecklist.evidenceState).toBe('PARTIAL');
    expect(serialized).not.toContain('private-staging.example');
    expect(report.hostedSmoke).toMatchObject({
      state: 'COMPLETED',
      classification: 'READY_FOR_SUPERVISED_UAT',
      deploymentCommit: COMMIT,
    });
  });

  it('produces deterministic parseable JSON and key-value output', async () => {
    const report = await collectM6OperationalReadiness({
      repositoryRoot: createRepositoryFixture(),
      gitEvidence: { branch: 'infra/m6-operational-readiness', commit: COMMIT },
      env: {},
    });
    const first = JSON.stringify(report, null, 2);
    const second = JSON.stringify(report, null, 2);
    const human = formatM6OperationalReadinessReport(report);

    expect(JSON.parse(first)).toEqual(report);
    expect(second).toBe(first);
    expect(human).toContain('HOSTED_SMOKE = NOT_RUN');
    expect(human).toContain(
      'M6_OPERATIONAL_READINESS_CLASSIFICATION = REPOSITORY_READY_HOSTED_CHECK_NOT_RUN',
    );
  });
});

describe('M6 operational readiness CLI safety', () => {
  it('accepts only the bounded optional URL, commit, and JSON options', () => {
    expect(parseM6OperationalReadinessCliArgs([
      '--base-url=https://staging.example',
      `--expected-commit=${COMMIT.toUpperCase()}`,
      '--json',
    ])).toMatchObject({ expectedCommit: COMMIT, json: true });
  });

  it.each([
    ['--base-url=http://staging.example'],
    ['--base-url=https://user:password@staging.example'],
    ['--base-url=https://staging.example?token=private'],
    ['--expected-commit=short'],
    ['--token=private'],
  ])('rejects unsafe or unsupported input without reflecting it: %s', (argument) => {
    expect(() => parseM6OperationalReadinessCliArgs([argument])).toThrow(
      M6OperationalReadinessInputError,
    );
  });
});
