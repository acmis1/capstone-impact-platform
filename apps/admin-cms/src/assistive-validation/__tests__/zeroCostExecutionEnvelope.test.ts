import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AZURE_CONTAINER_APPS_CONSUMPTION_GRANT,
  computeZeroCostEnvelope,
  dispatcherExecutionsForCron,
  DISPATCHER_JOB_SHAPE,
  HEAVY_WORKER_JOB_SHAPE,
  LAUNCH_ENVELOPE,
  VERIFIED_DISPATCHER_CRON_EXPRESSIONS,
} from '../../operations/zeroCostExecutionEnvelope';
import { checkZeroCostEnvelope } from '../../scripts/checkZeroCostEnvelope';
import {
  LAUNCH_LIMIT_PER_ROLLING_WINDOW,
  LAUNCH_WINDOW_DAYS,
  MAX_ACTIVE_HEAVY_EXECUTIONS,
  RESERVATION_TTL_SECONDS,
  ON_DEMAND_RUNTIME_BUDGET_MS,
  redactReservationToken,
} from '../domain/executionControlContract';
import { getAssistiveDispatcherConfig } from '../services/assistiveDispatcherConfig';
import { getHostedAssistiveWorkerConfig } from '../services/hostedAssistiveWorkerConfig';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

const workerEnvironment = (overrides: Record<string, string | undefined> = {}) => ({
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'true',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging-project.supabase.co',
  CAPSTONE_ASSISTIVE_SUPABASE_URL: 'https://staging-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_worker-test',
  CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR: resolve('qualified-paddle-models'),
  CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE: resolve('qualified-language', 'LanguageTool-stable.zip'),
  CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR: resolve('qualified-language', 'LanguageTool-6.6', 'languagetool-server.jar'),
  ...overrides,
});

const dispatcherEnvironment = (overrides: Record<string, string | undefined> = {}) => ({
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'true',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging-project.supabase.co',
  CAPSTONE_ASSISTIVE_SUPABASE_URL: 'https://staging-project.supabase.co',
  CAPSTONE_ASSISTIVE_DISPATCHER_INSTANCE_ID: 'capstone-assistive-dispatcher',
  CAPSTONE_ASSISTIVE_DISPATCHER_DB_URL:
    'postgresql://capstone_assistive_dispatcher.projectref:secret@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres',
  CAPSTONE_DEPLOYMENT_VERSION: COMMIT,
  CAPSTONE_ASSISTIVE_IMAGE_DIGEST: DIGEST,
  CAPSTONE_ASSISTIVE_WORKER_JOB_NAME: 'capstone-assistive-worker',
  AZURE_SUBSCRIPTION_ID: '11111111-2222-4333-8444-555555555555',
  AZURE_CLIENT_ID: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  AZURE_RESOURCE_GROUP: 'rg-capstone-assistive',
  IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
  IDENTITY_HEADER: 'identity-header-value',
  ...overrides,
});

describe('zero-cost execution envelope', () => {
  it('1. Keeps worst-case configured usage inside the verified free grant', () => {
    const envelope = computeZeroCostEnvelope();
    expect(envelope.jobs[0]).toMatchObject({ executions: 22_320, vcpuSeconds: 83_700, gibSeconds: 167_400 });
    expect(envelope.jobs[1]).toMatchObject({ executions: 40, vcpuSeconds: 50_400, gibSeconds: 100_800 });
    expect(envelope.totalVcpuSeconds).toBe(134_100);
    expect(envelope.totalGibSeconds).toBe(268_200);
    expect(envelope.withinGrant).toBe(true);
    expect(envelope.vcpuUtilisation).toBeCloseTo(0.745, 3);
    expect(envelope.gibUtilisation).toBeCloseTo(0.745, 3);
  });

  it('2. Publishes the dispatcher start-time headroom rather than implying none is needed', () => {
    expect(computeZeroCostEnvelope().dispatcherStartAllowanceHeadroomSeconds).toBeCloseTo(8.2, 1);
  });

  it('3. Refuses a configuration that would exceed the grant', () => {
    const envelope = computeZeroCostEnvelope(
      { ...DISPATCHER_JOB_SHAPE, executionsPerWorstCaseMonth: 22_320, replicaTimeoutSeconds: 60 },
      HEAVY_WORKER_JOB_SHAPE,
    );
    expect(envelope.withinGrant).toBe(false);
    expect(envelope.dispatcherStartAllowanceHeadroomSeconds).toBeLessThan(0);
  });

  it('4. Derives worst-case executions from the reviewed cadences only', () => {
    expect(dispatcherExecutionsForCron('*/2 * * * *')).toBe(22_320);
    expect(dispatcherExecutionsForCron('*/3 * * * *')).toBe(14_880);
    expect(() => dispatcherExecutionsForCron('0 * * * *')).toThrow('ZERO_COST_UNSUPPORTED_CRON_EXPRESSION');
    expect(VERIFIED_DISPATCHER_CRON_EXPRESSIONS).toContain(DISPATCHER_JOB_SHAPE.cronExpression);
  });

  it('5. Records the grant with its official source and verification date', () => {
    expect(AZURE_CONTAINER_APPS_CONSUMPTION_GRANT).toMatchObject({
      vcpuSecondsPerMonth: 180_000,
      gibSecondsPerMonth: 360_000,
      scope: 'per subscription, per calendar month',
      verifiedOn: '2026-08-28',
    });
    expect(AZURE_CONTAINER_APPS_CONSUMPTION_GRANT.source).toMatch(/^https:\/\/learn\.microsoft\.com\//);
  });

  it('6. Keeps both jobs on supported single-replica Consumption shapes', () => {
    for (const shape of [DISPATCHER_JOB_SHAPE, HEAVY_WORKER_JOB_SHAPE]) {
      expect(shape.parallelism).toBe(1);
      expect(shape.replicaCompletionCount).toBe(1);
      expect(shape.replicaRetryLimit).toBe(0);
      expect(shape.memoryGib).toBe(shape.vcpu * 2);
    }
    expect(HEAVY_WORKER_JOB_SHAPE.vcpu).toBe(2);
    expect(HEAVY_WORKER_JOB_SHAPE.replicaTimeoutSeconds).toBe(600);
  });

  it('7. Fixes the launch ceiling to a rolling window rather than a calendar month', () => {
    expect(LAUNCH_LIMIT_PER_ROLLING_WINDOW).toBe(40);
    expect(LAUNCH_WINDOW_DAYS).toBe(31);
    expect(MAX_ACTIVE_HEAVY_EXECUTIONS).toBe(1);
    expect(LAUNCH_ENVELOPE.refundableState).toBe('PRESTART_FAILED');
    expect(LAUNCH_ENVELOPE.irrevocableStates).toContain('START_REQUESTED');
    expect(LAUNCH_ENVELOPE.irrevocableStates).not.toContain('PRESTART_FAILED');
  });

  it('8. Keeps the reservation fence longer than one heavy execution can run', () => {
    expect(RESERVATION_TTL_SECONDS).toBeGreaterThan(HEAVY_WORKER_JOB_SHAPE.replicaTimeoutSeconds);
    expect(ON_DEMAND_RUNTIME_BUDGET_MS / 1000)
      .toBeLessThan(HEAVY_WORKER_JOB_SHAPE.replicaTimeoutSeconds);
  });

  it('9. Passes the repository zero-cost architecture guard', () => {
    expect(checkZeroCostEnvelope().failures).toEqual([]);
  });
});

describe('provider-neutral execution identity', () => {
  it('10. Prefers canonical identity variables over the historical hosting aliases', () => {
    const config = getHostedAssistiveWorkerConfig(workerEnvironment({
      CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID: 'capstone-worker-01',
      CAPSTONE_DEPLOYMENT_VERSION: COMMIT,
      RENDER_INSTANCE_ID: 'srv-legacy',
      RENDER_GIT_COMMIT: 'c'.repeat(40),
    }));
    expect(config).toMatchObject({
      workerInstanceId: 'capstone-worker-01',
      deploymentVersion: COMMIT,
      executionMode: 'CONTINUOUS',
      imageDigest: null,
      reservation: null,
    });
  });

  it('11. Still accepts the historical aliases so the continuous profile keeps working', () => {
    expect(getHostedAssistiveWorkerConfig(workerEnvironment({
      RENDER_INSTANCE_ID: 'srv-worker.01:instance-1',
      RENDER_GIT_COMMIT: COMMIT,
    }))).toMatchObject({ workerInstanceId: 'srv-worker.01:instance-1', deploymentVersion: COMMIT });
  });

  it('12. Requires an image digest and a reservation for on-demand execution', () => {
    const base = workerEnvironment({
      CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID: 'capstone-worker-01',
      CAPSTONE_DEPLOYMENT_VERSION: COMMIT,
      CAPSTONE_ASSISTIVE_EXECUTION_MODE: 'ON_DEMAND',
    });
    expect(() => getHostedAssistiveWorkerConfig(base)).toThrow(/image identity|configuration is invalid/);

    const withDigest = { ...base, CAPSTONE_ASSISTIVE_IMAGE_DIGEST: DIGEST };
    expect(() => getHostedAssistiveWorkerConfig(withDigest)).toThrow(/configuration is invalid/);

    expect(getHostedAssistiveWorkerConfig({
      ...withDigest,
      CAPSTONE_ASSISTIVE_RESERVATION_TOKEN: '3f1d2f5a-9c4b-4f2e-8a1d-0b7c6e5d4f3a',
      CAPSTONE_ASSISTIVE_RESERVATION_GENERATION: '7',
    })).toMatchObject({
      executionMode: 'ON_DEMAND',
      imageDigest: DIGEST,
      reservation: { token: '3f1d2f5a-9c4b-4f2e-8a1d-0b7c6e5d4f3a', generation: 7 },
    });
  });

  it.each([
    ['a malformed reservation token', { CAPSTONE_ASSISTIVE_RESERVATION_TOKEN: 'not-a-token' }],
    ['a non-positive generation', { CAPSTONE_ASSISTIVE_RESERVATION_GENERATION: '0' }],
    ['an unknown execution mode', { CAPSTONE_ASSISTIVE_EXECUTION_MODE: 'BURST' }],
  ])('13. Refuses %s', (_label, overrides) => {
    expect(() => getHostedAssistiveWorkerConfig(workerEnvironment({
      CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID: 'capstone-worker-01',
      CAPSTONE_DEPLOYMENT_VERSION: COMMIT,
      CAPSTONE_ASSISTIVE_EXECUTION_MODE: 'ON_DEMAND',
      CAPSTONE_ASSISTIVE_IMAGE_DIGEST: DIGEST,
      CAPSTONE_ASSISTIVE_RESERVATION_TOKEN: '3f1d2f5a-9c4b-4f2e-8a1d-0b7c6e5d4f3a',
      CAPSTONE_ASSISTIVE_RESERVATION_GENERATION: '7',
      ...overrides,
    }))).toThrow();
  });

  it('14. Never logs a reservation token in full', () => {
    expect(redactReservationToken('3f1d2f5a-9c4b-4f2e-8a1d-0b7c6e5d4f3a')).toBe('3f1d2f5a…');
    expect(redactReservationToken('short')).toBe('…');
  });
});

describe('dispatcher configuration', () => {
  it('15. Accepts only the dedicated least-privilege execution-control database role', () => {
    expect(getAssistiveDispatcherConfig(dispatcherEnvironment())).toMatchObject({
      dispatcherInstanceId: 'capstone-assistive-dispatcher',
      deploymentVersion: COMMIT,
      imageDigest: DIGEST,
    });
  });

  it.each([
    ['the database owner role', 'postgresql://postgres.projectref:secret@pooler.supabase.com:5432/postgres'],
    ['the Data API role', 'postgresql://authenticator.projectref:secret@pooler.supabase.com:5432/postgres'],
    ['a non-PostgreSQL target', 'https://pooler.supabase.com:5432/postgres'],
  ])('16. Refuses %s', (_label, url) => {
    expect(() => getAssistiveDispatcherConfig(dispatcherEnvironment({
      CAPSTONE_ASSISTIVE_DISPATCHER_DB_URL: url,
    }))).toThrow(/database URL/);
  });

  it('17. Refuses an unverified staging target or a disabled feature flag', () => {
    expect(() => getAssistiveDispatcherConfig(dispatcherEnvironment({
      CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'false',
    }))).toThrow(/not explicitly enabled/);
    expect(() => getAssistiveDispatcherConfig(dispatcherEnvironment({
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'other-project.supabase.co',
    }))).toThrow(/Staging Execution Refused/);
  });

  it('18. Refuses a mutable worker image identity', () => {
    expect(() => getAssistiveDispatcherConfig(dispatcherEnvironment({
      CAPSTONE_ASSISTIVE_IMAGE_DIGEST: 'latest',
    }))).toThrow(/image identity is invalid/);
  });
});
