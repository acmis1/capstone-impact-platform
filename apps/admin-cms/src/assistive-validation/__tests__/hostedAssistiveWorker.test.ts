import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ASSISTIVE_WORKER_COMPATIBILITY } from '../domain/workerHeartbeatContract';
import { SupabaseAssistiveWorkerHeartbeatRepository } from '../repositories/assistiveWorkerHeartbeatRepository';
import { isAssistiveExecutionAvailable } from '../services/assistiveExecutionAvailability';
import { getHostedAssistiveWorkerConfig } from '../services/hostedAssistiveWorkerConfig';
import { runHostedAssistiveWorkerLoop } from '../services/hostedAssistiveWorkerLoop';
import { AssistiveWorkerHeartbeatPublisher } from '../services/assistiveWorkerHeartbeat';

const COMMIT = 'a'.repeat(40);
const validEnvironment = () => ({
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'true',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging-project.supabase.co',
  CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: COMMIT,
  CAPSTONE_ASSISTIVE_SUPABASE_URL: 'https://staging-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_worker-test',
  RENDER: 'true',
  RENDER_INSTANCE_ID: 'srv-worker.01:instance-1',
  RENDER_GIT_COMMIT: COMMIT,
  CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR: resolve('qualified-paddle-models'),
  CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE: resolve('qualified-language', 'LanguageTool-stable.zip'),
  CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR: resolve('qualified-language', 'LanguageTool-6.6', 'languagetool-server.jar'),
});

const validProductionEnvironment = () => ({
  ...validEnvironment(),
  CAPSTONE_RUNTIME_ENV: 'production',
  CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: 'true',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'production-project.supabase.co',
  CAPSTONE_ASSISTIVE_SUPABASE_URL: 'https://production-project.supabase.co',
  CAPSTONE_ASSISTIVE_EXECUTION_MODE: 'CONTINUOUS',
});

const availabilityGateway = (response: unknown) => ({
  record: vi.fn(),
  availability: vi.fn().mockResolvedValue(response),
});

describe('hosted assistive worker configuration and availability', () => {
  it('accepts only the explicit verified staging target and frozen provider paths', () => {
    expect(getHostedAssistiveWorkerConfig(validEnvironment())).toMatchObject({
      runtimeEnvironment: 'staging',
      supabaseUrl: 'https://staging-project.supabase.co',
      workerInstanceId: 'srv-worker.01:instance-1',
      deploymentVersion: COMMIT,
    });
  });

  it('accepts an explicitly enabled verified production continuous worker', () => {
    expect(getHostedAssistiveWorkerConfig(validProductionEnvironment())).toMatchObject({
      runtimeEnvironment: 'production',
      supabaseUrl: 'https://production-project.supabase.co',
      executionMode: 'CONTINUOUS',
      imageDigest: null,
      reservation: null,
    });
  });

  it.each([undefined, 'false', 'TRUE', ' true '])(
    'rejects production when its capability flag is %s',
    (flag) => {
      expect(() => getHostedAssistiveWorkerConfig({
        ...validProductionEnvironment(),
        CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: flag,
      })).toThrow(/not explicitly enabled/);
    },
  );

  it('rejects production on-demand execution even with reservation credentials', () => {
    expect(() => getHostedAssistiveWorkerConfig({
      ...validProductionEnvironment(),
      CAPSTONE_ASSISTIVE_EXECUTION_MODE: 'ON_DEMAND',
      CAPSTONE_ASSISTIVE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
      CAPSTONE_ASSISTIVE_RESERVATION_TOKEN: '3f1d2f5a-9c4b-4f2e-8a1d-0b7c6e5d4f3a',
      CAPSTONE_ASSISTIVE_RESERVATION_GENERATION: '1',
    })).toThrow(/must use continuous mode/);
  });

  it.each([
    ['disabled feature', { CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'false' }],
    ['wrong environment', { CAPSTONE_RUNTIME_ENV: 'production' }],
    ['wrong host', { CAPSTONE_ASSISTIVE_SUPABASE_URL: 'https://other.supabase.co' }],
    ['missing secret credential', { SUPABASE_SECRET_KEY: undefined }],
    ['non-secret credential', { SUPABASE_SECRET_KEY: 'sb_publishable_browser' }],
    ['malformed instance identity', { RENDER_INSTANCE_ID: '../worker' }],
    ['malformed deployment identity', { RENDER_GIT_COMMIT: 'latest' }],
    ['relative model path', { CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR: 'models' }],
    ['missing LanguageTool JAR', { CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR: undefined }],
    ['unfrozen archive name', { CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE: resolve('LanguageTool-latest.zip') }],
  ])('rejects %s', (_label, override) => {
    expect(() => getHostedAssistiveWorkerConfig({ ...validEnvironment(), ...override })).toThrow();
  });

  it('rejects noncanonical or conflicting worker deployment identities', () => {
    expect(() => getHostedAssistiveWorkerConfig({
      ...validEnvironment(),
      CAPSTONE_DEPLOYMENT_VERSION: COMMIT.toUpperCase(),
      RENDER_GIT_COMMIT: undefined,
    })).toThrow(/deployment identity/);
    expect(() => getHostedAssistiveWorkerConfig({
      ...validEnvironment(),
      CAPSTONE_DEPLOYMENT_VERSION: COMMIT,
      RENDER_GIT_COMMIT: 'c'.repeat(40),
    })).toThrow(/deployment identity/);
    expect(() => getHostedAssistiveWorkerConfig({
      ...validEnvironment(),
      CAPSTONE_ASSISTIVE_EXECUTION_MODE: 'ON_DEMAND',
      CAPSTONE_ASSISTIVE_IMAGE_DIGEST: `SHA256:${'B'.repeat(64)}`,
      CAPSTONE_ASSISTIVE_RESERVATION_TOKEN: '3f1d2f5a-9c4b-4f2e-8a1d-0b7c6e5d4f3a',
      CAPSTONE_ASSISTIVE_RESERVATION_GENERATION: '1',
    })).toThrow(/image identity/);
  });

  it('keeps loopback execution available without a service heartbeat', async () => {
    await expect(isAssistiveExecutionAvailable('http://127.0.0.1:54321')).resolves.toBe(true);
  });

  it('enables verified staging only for a fresh compatible worker', async () => {
    const env = validEnvironment();
    const gateway = availabilityGateway({
      resultCode: 'AVAILABLE', compatibleWorkerCount: 2,
      latestHeartbeatAt: '2026-08-28T01:00:00.000Z',
    });
    await expect(isAssistiveExecutionAvailable(
      env.CAPSTONE_ASSISTIVE_SUPABASE_URL,
      gateway,
      env,
    )).resolves.toBe(true);
    expect(gateway.availability).toHaveBeenCalledOnce();
  });

  it('enables verified production only for a fresh compatible continuous heartbeat', async () => {
    const env = validProductionEnvironment();
    const heartbeat = availabilityGateway({
      resultCode: 'AVAILABLE', compatibleWorkerCount: 1,
      latestHeartbeatAt: '2026-09-10T01:00:00.000Z',
    });
    const onDemand = { availability: vi.fn() };
    await expect(isAssistiveExecutionAvailable(
      env.CAPSTONE_ASSISTIVE_SUPABASE_URL,
      heartbeat,
      env,
      onDemand as never,
    )).resolves.toBe(true);
    expect(heartbeat.availability).toHaveBeenCalledOnce();
    expect(onDemand.availability).not.toHaveBeenCalled();
  });

  it('keeps production unavailable for stale or incompatible heartbeat and never queries on-demand control', async () => {
    for (const response of [
      { resultCode: 'UNAVAILABLE', compatibleWorkerCount: 0, latestHeartbeatAt: null },
      { resultCode: 'AVAILABLE', compatibleWorkerCount: -1, latestHeartbeatAt: 'not-a-time' },
    ]) {
      const env = validProductionEnvironment();
      const onDemand = { availability: vi.fn().mockResolvedValue({ resultCode: 'AVAILABLE' }) };
      await expect(isAssistiveExecutionAvailable(
        env.CAPSTONE_ASSISTIVE_SUPABASE_URL,
        availabilityGateway(response),
        env,
        onDemand as never,
      )).resolves.toBe(false);
      expect(onDemand.availability).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['stale or absent', { resultCode: 'UNAVAILABLE', compatibleWorkerCount: 0, latestHeartbeatAt: null }],
    ['malformed', { resultCode: 'AVAILABLE', compatibleWorkerCount: -1, latestHeartbeatAt: 'not-a-time' }],
    ['validation failure', { resultCode: 'VALIDATION_FAILED' }],
  ])('fails closed for %s heartbeat evidence', async (_label, response) => {
    const env = validEnvironment();
    await expect(isAssistiveExecutionAvailable(
      env.CAPSTONE_ASSISTIVE_SUPABASE_URL,
      availabilityGateway(response),
      env,
    )).resolves.toBe(false);
  });

  it('never queries heartbeat state for unqualified production, a mismatched host, or a disabled flag', async () => {
    for (const override of [
      { CAPSTONE_RUNTIME_ENV: 'production' },
      {
        CAPSTONE_RUNTIME_ENV: 'production',
        CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: 'true',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'other.supabase.co',
      },
      { CAPSTONE_EXPECTED_SUPABASE_HOST: 'other.supabase.co' },
      { CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'false' },
    ]) {
      const env = { ...validEnvironment(), ...override };
      const gateway = availabilityGateway({ resultCode: 'AVAILABLE', compatibleWorkerCount: 1, latestHeartbeatAt: new Date().toISOString() });
      await expect(isAssistiveExecutionAvailable(env.CAPSTONE_ASSISTIVE_SUPABASE_URL, gateway, env))
        .resolves.toBe(false);
      expect(gateway.availability).not.toHaveBeenCalled();
    }
  });

  it('never queries heartbeat state without one exact expected worker and verified application deployment identity', async () => {
    for (const override of [
      { CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: undefined },
      { CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: COMMIT.toUpperCase() },
      { CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: 'b'.repeat(40) },
      { RENDER_GIT_COMMIT: COMMIT.toUpperCase() },
      { RENDER: 'false' },
    ]) {
      const env = { ...validEnvironment(), ...override };
      const gateway = availabilityGateway({
        resultCode: 'AVAILABLE', compatibleWorkerCount: 1,
        latestHeartbeatAt: new Date().toISOString(),
      });
      await expect(isAssistiveExecutionAvailable(env.CAPSTONE_ASSISTIVE_SUPABASE_URL, gateway, env))
        .resolves.toBe(false);
      expect(gateway.availability).not.toHaveBeenCalled();
    }
  });

  it('does not let either environment capability substitute for the other target', async () => {
    const staging = { ...validEnvironment(), CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'false', CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: 'true' };
    const production = { ...validProductionEnvironment(), CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED: undefined };
    for (const env of [staging, production]) {
      const gateway = availabilityGateway({ resultCode: 'AVAILABLE', compatibleWorkerCount: 1, latestHeartbeatAt: new Date().toISOString() });
      await expect(isAssistiveExecutionAvailable(env.CAPSTONE_ASSISTIVE_SUPABASE_URL, gateway, env))
        .resolves.toBe(false);
      expect(gateway.availability).not.toHaveBeenCalled();
    }
  });

  it.each(['staging', 'production'] as const)(
    'carries the verified %s runtime identity to availability and publication RPCs',
    async (environment) => {
      const rpc = vi.fn().mockResolvedValue({ data: { resultCode: 'AVAILABLE' }, error: null });
      const repository = new SupabaseAssistiveWorkerHeartbeatRepository({ rpc } as never, {
        environment,
        deploymentVersion: COMMIT,
      });
      await repository.availability();
      await repository.record({ workerInstanceId: 'srv-1', deploymentVersion: COMMIT, healthState: 'READY' });
      expect(rpc.mock.calls[0]).toEqual(['get_assistive_worker_availability', {
        p_environment: environment,
        p_pipeline_version: ASSISTIVE_WORKER_COMPATIBILITY.pipelineVersion,
        p_deployment_version: COMMIT,
        p_ocr_capability: ASSISTIVE_WORKER_COMPATIBILITY.ocrCapability,
        p_language_capability: ASSISTIVE_WORKER_COMPATIBILITY.languageCapability,
        p_freshness_seconds: 60,
      }]);
      expect(rpc.mock.calls[1]).toEqual(['upsert_assistive_worker_heartbeat', {
        p_worker_instance_id: 'srv-1',
        p_environment: environment,
        p_pipeline_version: ASSISTIVE_WORKER_COMPATIBILITY.pipelineVersion,
        p_deployment_version: COMMIT,
        p_ocr_capability: ASSISTIVE_WORKER_COMPATIBILITY.ocrCapability,
        p_language_capability: ASSISTIVE_WORKER_COMPATIBILITY.languageCapability,
        p_health_state: 'READY',
      }]);
    },
  );

  it.each([undefined, '', 'local', 'Production'])(
    'fails closed without an exact hosted heartbeat environment (%s)',
    async (environment) => {
      const rpc = vi.fn();
      const repository = new SupabaseAssistiveWorkerHeartbeatRepository({ rpc } as never, {
        environment,
        deploymentVersion: COMMIT,
      });
      await expect(repository.availability()).resolves.toEqual({ resultCode: 'VALIDATION_FAILED' });
      await expect(repository.record({
        workerInstanceId: 'srv-1',
        deploymentVersion: COMMIT,
        healthState: 'READY',
      })).resolves.toEqual({ resultCode: 'VALIDATION_FAILED' });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('refuses to publish a heartbeat under a deployment identity different from its runtime identity', async () => {
    const rpc = vi.fn();
    const repository = new SupabaseAssistiveWorkerHeartbeatRepository({ rpc } as never, {
      environment: 'production',
      deploymentVersion: COMMIT,
    });
    await expect(repository.record({
      workerInstanceId: 'srv-1',
      deploymentVersion: 'b'.repeat(40),
      healthState: 'READY',
    })).resolves.toEqual({ resultCode: 'VALIDATION_FAILED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['staging', validEnvironment],
    ['production', validProductionEnvironment],
  ] as const)('carries configured %s identity through the consumer and producer layers', async (
    environment,
    environmentFactory,
  ) => {
    const env = environmentFactory();
    const config = getHostedAssistiveWorkerConfig(env);
    const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      void parameters;
      return {
        data: name === 'get_assistive_worker_availability'
          ? { resultCode: 'AVAILABLE', compatibleWorkerCount: 1, latestHeartbeatAt: new Date().toISOString() }
          : { resultCode: 'HEARTBEAT_RECORDED', healthState: 'READY', heartbeatAt: new Date().toISOString() },
        error: null,
      };
    });
    const repository = new SupabaseAssistiveWorkerHeartbeatRepository({ rpc } as never, {
      environment: config.runtimeEnvironment,
      deploymentVersion: config.deploymentVersion,
    });

    await expect(isAssistiveExecutionAvailable(
      config.supabaseUrl,
      repository,
      env,
    )).resolves.toBe(true);
    await new AssistiveWorkerHeartbeatPublisher(
      repository,
      config.workerInstanceId,
      config.deploymentVersion,
    ).publish('READY');

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_environment: environment });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_environment: environment });
  });
});

describe('hosted assistive worker lifecycle', () => {
  it('refuses to publish READY or claim when preflight fails', async () => {
    const heartbeat = { publish: vi.fn() };
    const runOnce = vi.fn();
    await expect(runHostedAssistiveWorkerLoop({
      signal: new AbortController().signal,
      health: vi.fn().mockResolvedValue(false),
      runOnce,
      heartbeat,
    })).rejects.toThrow('ASSISTIVE_WORKER_PREFLIGHT_FAILED');
    expect(runOnce).not.toHaveBeenCalled();
    expect(heartbeat.publish).not.toHaveBeenCalled();
  });

  it('publishes READY, waits while idle, and publishes STOPPING on shutdown', async () => {
    const controller = new AbortController();
    const heartbeat = { publish: vi.fn().mockResolvedValue(undefined) };
    const wait = vi.fn().mockImplementation(async (_milliseconds, signal: AbortSignal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
    });
    await runHostedAssistiveWorkerLoop({
      signal: controller.signal,
      health: vi.fn().mockResolvedValue(true),
      runOnce: vi.fn().mockResolvedValue({ outcome: 'EMPTY' }),
      heartbeat,
      wait,
    });
    expect(wait).toHaveBeenCalledWith(2_000, controller.signal);
    expect(heartbeat.publish.mock.calls).toEqual([['READY'], ['STOPPING']]);
  });

  it('finishes the current fenced job after SIGTERM and does not claim another', async () => {
    const controller = new AbortController();
    const heartbeat = { publish: vi.fn().mockResolvedValue(undefined) };
    let finishJob!: () => void;
    const runningJob = new Promise<void>((resolveJob) => { finishJob = resolveJob; });
    const runOnce = vi.fn().mockImplementation(async () => {
      controller.abort();
      finishJob();
      await runningJob;
      return { outcome: 'FINALIZED' as const, runId: 'run-1' };
    });
    await runHostedAssistiveWorkerLoop({
      signal: controller.signal,
      health: vi.fn().mockResolvedValue(true),
      runOnce,
      heartbeat,
    });
    expect(runOnce).toHaveBeenCalledOnce();
    expect(heartbeat.publish).toHaveBeenLastCalledWith('STOPPING');
  });

  it('waits for an in-flight READY heartbeat before publishing STOPPING', async () => {
    const controller = new AbortController();
    const publications: string[] = [];
    let beginSecondReady!: () => void;
    let releaseSecondReady!: () => void;
    const secondReadyStarted = new Promise<void>((resolve) => { beginSecondReady = resolve; });
    const secondReadyReleased = new Promise<void>((resolve) => { releaseSecondReady = resolve; });
    let readyCount = 0;
    const heartbeat = {
      publish: vi.fn().mockImplementation(async (state: string) => {
        publications.push(state);
        if (state === 'READY' && ++readyCount === 2) {
          beginSecondReady();
          await secondReadyReleased;
        }
      }),
    };
    const runOnce = vi.fn().mockImplementation(async () => {
      await secondReadyStarted;
      controller.abort();
      releaseSecondReady();
      return { outcome: 'FINALIZED' as const, runId: 'run-1' };
    });

    await runHostedAssistiveWorkerLoop({
      signal: controller.signal,
      health: vi.fn().mockResolvedValue(true),
      runOnce,
      heartbeat,
      heartbeatIntervalMs: 1,
    });

    expect(publications).toEqual(['READY', 'READY', 'STOPPING']);
  });
});
