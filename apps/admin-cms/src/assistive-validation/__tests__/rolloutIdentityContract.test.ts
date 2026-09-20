import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveAssistiveWorkerRuntimeIdentity } from '../repositories/assistiveWorkerHeartbeatRepository';
import { resolveAssistiveExecutionAvailability } from '../services/assistiveExecutionAvailability';
import { ASSISTIVE_WORKER_COMPATIBILITY } from '../domain/workerHeartbeatContract';

/**
 * Pins the identity assumptions that docs/operations/release-rollout-runbook.md documents: an
 * application commit change is a coordinated change of application build, expected-worker
 * configuration and worker identity. Pipeline/capability compatibility alone never makes a worker
 * available.
 */
const repoRoot = path.resolve(__dirname, '../../../../../');
const OLD = '9690ee0faa37fda502a15b4403f1e293f79b519f';
const NEW = '49eea9b11743830ab46f391981e8aed4310aa915';
const SUPABASE_URL = 'https://sqkpceeltukbzxpsvinb.supabase.co';

function renderEnvironment(overrides: Record<string, string | undefined>) {
  return {
    CAPSTONE_RUNTIME_ENV: 'staging',
    RENDER: 'true',
    RENDER_GIT_COMMIT: OLD,
    CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: OLD,
    CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'true',
    CAPSTONE_EXPECTED_SUPABASE_HOST: 'sqkpceeltukbzxpsvinb.supabase.co',
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    ...overrides,
  } as Record<string, string | undefined>;
}

/** A heartbeat gateway that answers like the database function: available only for one deployment version. */
function heartbeatGatewayFor(workerDeploymentVersion: string) {
  return {
    record: async () => ({ resultCode: 'HEARTBEAT_RECORDED' }),
    availability: async () => ({ resultCode: 'AVAILABLE', compatibleWorkerCount: 1, latestHeartbeatAt: new Date().toISOString() }),
    // The real repository passes the resolved identity to the database; this fake records what it would send.
    workerDeploymentVersion,
  };
}

describe('rollout identity contract', () => {
  it('resolves only when the application runtime commit equals the expected worker commit', () => {
    expect(resolveAssistiveWorkerRuntimeIdentity(renderEnvironment({}))).toEqual({ environment: 'staging', deploymentVersion: OLD });
    // Redeploying the application at a new commit with an unchanged expected identity fails closed.
    expect(resolveAssistiveWorkerRuntimeIdentity(renderEnvironment({ RENDER_GIT_COMMIT: NEW }))).toBeNull();
    // Updating the expected identity without redeploying the application also fails closed.
    expect(resolveAssistiveWorkerRuntimeIdentity(renderEnvironment({ CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: NEW }))).toBeNull();
    // Both moved together: resolves to the new identity.
    expect(resolveAssistiveWorkerRuntimeIdentity(renderEnvironment({ RENDER_GIT_COMMIT: NEW, CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: NEW })))
      .toEqual({ environment: 'staging', deploymentVersion: NEW });
    // A provider-neutral host uses CAPSTONE_DEPLOYMENT_VERSION with the same rule.
    expect(resolveAssistiveWorkerRuntimeIdentity(renderEnvironment({ RENDER: undefined, RENDER_GIT_COMMIT: undefined, CAPSTONE_DEPLOYMENT_VERSION: NEW, CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: NEW })))
      .toEqual({ environment: 'staging', deploymentVersion: NEW });
    expect(resolveAssistiveWorkerRuntimeIdentity(renderEnvironment({ RENDER: undefined, RENDER_GIT_COMMIT: undefined, CAPSTONE_DEPLOYMENT_VERSION: NEW })))
      .toBeNull();
  });

  it('never reports the continuous worker available while the application identity is unresolved, whatever the heartbeat says', async () => {
    const gateway = heartbeatGatewayFor(NEW);
    // Application redeployed at NEW, expected identity still OLD: the resolver fails before the heartbeat is consulted.
    const mismatched = await resolveAssistiveExecutionAvailability(SUPABASE_URL, gateway, undefined, renderEnvironment({ RENDER_GIT_COMMIT: NEW }));
    expect(mismatched).toEqual({ state: 'TEMPORARILY_UNAVAILABLE', canEnqueue: false, message: expect.stringContaining('temporarily unavailable') });
    // Consistent application + configuration with a compatible fresh heartbeat: available.
    const consistent = await resolveAssistiveExecutionAvailability(SUPABASE_URL, gateway, undefined, renderEnvironment({ RENDER_GIT_COMMIT: NEW, CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: NEW }));
    expect(consistent).toEqual({ state: 'READY', canEnqueue: true, message: null });
  });

  it('keeps the pipeline and capability identities that the database function requires', () => {
    expect(ASSISTIVE_WORKER_COMPATIBILITY).toEqual({
      pipelineVersion: 'assistive-deterministic-checks/v4',
      ocrCapability: 'paddle-title/pp-ocrv6-small@3.7.0',
      languageCapability: 'languagetool/en-au@6.6',
    });
    const sql = fs.readFileSync(path.join(repoRoot, 'infra/supabase/migrations/20260918120000_governed_project_maintenance.sql'), 'utf8');
    const routine = sql.slice(sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.get_assistive_worker_availability('));
    expect(routine).toContain('AND deployment_version = p_deployment_version');
    expect(routine).toContain("AND health_state = 'READY'");
  });

  it('documents the contract, the graceful-stop derivation and the composite release identity in the tracked runbook', () => {
    const runbook = fs.readFileSync(path.join(repoRoot, 'docs/operations/release-rollout-runbook.md'), 'utf8');
    for (const required of [
      'CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION',
      'CAPSTONE_DEPLOYMENT_VERSION',
      'RENDER_GIT_COMMIT',
      'get_assistive_worker_availability',
      'stop_grace_period: 10m',
      'STOPPING',
      'LEASE_SECONDS',
      'org.opencontainers.image.revision',
      'verify.sh running',
      'Do not redeploy to make the SHAs equal',
      'This proves the application only',
    ]) {
      expect(runbook, required).toContain(required);
    }
    expect(runbook).not.toMatch(/docker stop guarantees/i);
    const compose = fs.readFileSync(path.join(repoRoot, 'infra/assistive-worker/compose.yaml'), 'utf8');
    expect(compose).toContain('stop_grace_period: 10m');
    const entrypoint = fs.readFileSync(path.join(repoRoot, 'apps/admin-cms/src/scripts/runHostedAssistiveCoordinator.ts'), 'utf8');
    expect(entrypoint).toContain("process.once('SIGTERM', () => controller.abort());");
  });
});
