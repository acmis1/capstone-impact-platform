import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  git: vi.fn(), read: vi.fn(), sentinel: vi.fn(), prepare: vi.fn(),
  currentDeployment: vi.fn(), verifyPostDeploy: vi.fn(),
  hostedDatabase: vi.fn(), linkedProject: vi.fn(), localDatabase: vi.fn(),
  runtime: vi.fn(), hostedSmoke: vi.fn(),
}));
vi.mock('@next/env', () => ({ loadEnvConfig: vi.fn() }));
vi.mock('../operations/stagingApplicationRollback', async (importOriginal) => ({
  ...await importOriginal<typeof import('../operations/stagingApplicationRollback')>(),
  collectStagingRollbackGitEvidence: calls.git,
  readBoundedJsonFile: calls.read,
  createStagingDatabaseSentinel: calls.sentinel,
  prepareStagingApplicationRollback: calls.prepare,
  collectCurrentDeploymentEvidence: calls.currentDeployment,
  verifyStagingApplicationPostDeploy: calls.verifyPostDeploy,
}));
vi.mock('../recovery/supabaseRecoveryCli', () => ({
  readGate4SourceEvidence: calls.hostedDatabase, readLinkedProjectRef: calls.linkedProject,
}));
vi.mock('./checkGate4SchemaEvidence', async (importOriginal) => ({
  ...await importOriginal<typeof import('./checkGate4SchemaEvidence')>(),
  collectLocalGate4Evidence: calls.localDatabase,
}));
vi.mock('../security/stagingRuntimeIdentity', () => ({ assertVerifiedStagingRuntime: calls.runtime }));
vi.mock('../deployment/hostedDeploymentSmokeVerifier', () => ({
  parseHostedSmokeBaseUrl: (value: string) => new URL(value), runHostedSmokeVerifier: calls.hostedSmoke,
}));
import { parseStagingRollbackCliArgs, runCheckStagingApplicationRollback } from './checkStagingApplicationRollback';

const SHA = 'a'.repeat(40);
const DEPLOYED = 'b'.repeat(40);
function argumentsFor(command: 'local-preflight' | 'preflight'): string[] {
  return [command, '--json', `--target-commit=${SHA}`, `--current-deployed-commit=${DEPLOYED}`,
    '--intent=rollback', '--change-reference=change-123', '--review-approval-reference=review-123',
    '--ci-reference=ci-123', '--prior-deployment-reference=deployment-123',
    '--prior-smoke-reference=smoke-123', '--deployment-credential-reference=credential-123'];
}
function expectNoHostedReads(): void {
  expect(calls.hostedDatabase).not.toHaveBeenCalled();
  expect(calls.linkedProject).not.toHaveBeenCalled();
  expect(calls.localDatabase).not.toHaveBeenCalled();
  expect(calls.currentDeployment).not.toHaveBeenCalled();
  expect(calls.hostedSmoke).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  calls.git.mockReturnValue({ trackedCheckoutClean: true, targetReachableFromReviewedRef: true,
    currentDeployedReachableFromReviewedRef: true, currentCommit: SHA, reviewedRefCommit: SHA });
  calls.read.mockReturnValue({ value: {}, bytes: Buffer.from('{}') });
  calls.sentinel.mockReturnValue({});
  calls.prepare.mockReturnValue({ classification: 'LOCAL_EVIDENCE_MATCH_DATABASE_AUTHORITY_NOT_PROVEN' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('staging application rollback CLI authority boundaries', () => {
  it.each([
    ['unknown'], ['preflight', '--unknown=value'], ['preflight', '--json', '--json'],
    ['preflight', '--authorize', '--authorize'],
    ['preflight', '--target-commit=first', '--target-commit=second'],
  ])('rejects invalid or repeated CLI arguments: %j', (...args) => {
    expect(() => parseStagingRollbackCliArgs(args)).toThrow();
    expect(calls.git).not.toHaveBeenCalled();
    expectNoHostedReads();
  });

  it('rejects local-file authorization before reading any evidence or contacting a service', async () => {
    const exit = await runCheckStagingApplicationRollback([
      ...argumentsFor('local-preflight'), '--authorize', '--confirmation=forged',
    ]);
    expect(exit).toBe(1);
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('LOCAL_EVIDENCE_CANNOT_AUTHORIZE'));
    expectNoHostedReads();
  });

  it('keeps local file evidence unproven regardless of claimed provider provenance', async () => {
    calls.read.mockReturnValue({ value: { provenance: 'DIRECT_HOSTED_READ_ONLY' }, bytes: Buffer.from('{}') });
    const exit = await runCheckStagingApplicationRollback([
      ...argumentsFor('local-preflight'), '--gate4-evidence=fixture-evidence.json',
      '--gate4-attestation=fixture-attestation.json', '--observed-at=2026-09-10T00:00:00.000Z',
    ]);
    expect(exit, vi.mocked(process.stdout.write).mock.calls.map(([value]) => String(value)).join("\n")).toBe(2);
    expect(calls.read).toHaveBeenCalledTimes(2);
    expect(calls.sentinel).toHaveBeenCalledWith(expect.objectContaining({
      provenance: 'UNAUTHENTICATED_FILE_INPUT_NOT_HOSTED_AUTHORITY',
    }));
    expect(calls.prepare).toHaveBeenCalledWith(expect.objectContaining({
      databaseEvidenceAuthority: 'NOT_PROVEN', authorize: false,
      currentDeploymentEvidence: expect.objectContaining({ authority: 'NOT_PROVEN', smokeClassification: 'NOT_RUN' }),
    }));
    expectNoHostedReads();
  });

  it('refuses a dirty checkout before any hosted inspection', async () => {
    calls.git.mockReturnValue({ trackedCheckoutClean: false });
    expect(await runCheckStagingApplicationRollback(argumentsFor('preflight'))).toBe(1);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('TRACKED_CHECKOUT_DIRTY'));
    expectNoHostedReads();
  });

  it('refuses a rejected runtime identity before any hosted inspection', async () => {
    calls.runtime.mockImplementation(() => { throw new Error('STAGING_CONFIGURATION_INVALID'); });
    expect(await runCheckStagingApplicationRollback(argumentsFor('preflight'))).toBe(1);
    expect(calls.read).not.toHaveBeenCalled();
    expectNoHostedReads();
  });

  it('refuses a mismatched current deployment before database inspection', async () => {
    calls.currentDeployment.mockResolvedValue({ observedCommit: SHA, smokeClassification: 'READY_FOR_SUPERVISED_UAT' });
    const exit = await runCheckStagingApplicationRollback([
      ...argumentsFor('preflight'), '--base-url=https://staging.example',
    ]);
    expect(exit).toBe(1);
    expect(calls.currentDeployment).toHaveBeenCalledTimes(1);
    expect(calls.hostedDatabase).not.toHaveBeenCalled();
    expect(calls.linkedProject).not.toHaveBeenCalled();
    expect(calls.localDatabase).not.toHaveBeenCalled();
    expect(calls.prepare).not.toHaveBeenCalled();
  });

  it('rejects post-deploy authorization before even reading a saved plan', async () => {
    expect(await runCheckStagingApplicationRollback(['post-deploy', '--authorize'])).toBe(1);
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.verifyPostDeploy).not.toHaveBeenCalled();
    expectNoHostedReads();
  });

  it('does not inspect hosted services for an interrupted deployment report', async () => {
    calls.read.mockReturnValue({ value: { planDigest: 'sha256:fixture' }, bytes: Buffer.from('{}') });
    calls.verifyPostDeploy.mockReturnValue({ classification: 'DEPLOYMENT_INTERRUPTED',
      accepted: false, technicalVerificationPassed: false, blockers: ['INTERRUPTED'], abortAndRecovery: [] });
    expect(await runCheckStagingApplicationRollback(['post-deploy', '--json', '--plan=fixture.json',
      '--deployment-state=interrupted', '--deployment-reference=deployment-123'])).toBe(1);
    expect(calls.verifyPostDeploy).toHaveBeenCalledTimes(1);
    expectNoHostedReads();
  });
});

describe('local Gate 4 input envelope compatibility', () => {
  const raw = { formatVersion: 'fixture', migrations: ['fixture-version'] };
  it.each([
    { value: raw }, { value: { gate4_evidence: raw } }, { value: { gate4Evidence: raw } },
    { value: [{ gate4_evidence: raw }] }, { value: { rows: [{ gate4_evidence: raw }] } },
  ])('preserves exact input bytes while unwrapping the supported envelope %#', async ({ value }) => {
    const bytes = Buffer.from(JSON.stringify(value));
    calls.read.mockReturnValueOnce({ value, bytes }).mockReturnValueOnce({ value: {}, bytes: Buffer.from('{}') });
    const exit = await runCheckStagingApplicationRollback([
      ...argumentsFor('local-preflight'), '--gate4-evidence=fixture-evidence.json',
      '--gate4-attestation=fixture-attestation.json', '--observed-at=2026-09-10T00:00:00.000Z',
    ]);
    expect(exit).toBe(2);
    expect(calls.sentinel).toHaveBeenCalledWith(expect.objectContaining({
      gate4Evidence: raw, gate4EvidenceBytes: bytes,
      provenance: 'UNAUTHENTICATED_FILE_INPUT_NOT_HOSTED_AUTHORITY',
    }));
    expect(calls.prepare).toHaveBeenCalledWith(expect.objectContaining({
      gate4Evidence: raw, gate4EvidenceBytes: bytes, databaseEvidenceAuthority: 'NOT_PROVEN',
    }));
    expectNoHostedReads();
  });
});
