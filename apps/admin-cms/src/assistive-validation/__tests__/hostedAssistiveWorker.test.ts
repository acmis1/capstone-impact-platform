import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ASSISTIVE_WORKER_COMPATIBILITY } from '../domain/workerHeartbeatContract';
import { SupabaseAssistiveWorkerHeartbeatRepository } from '../repositories/assistiveWorkerHeartbeatRepository';
import { isAssistiveExecutionAvailable } from '../services/assistiveExecutionAvailability';
import { getHostedAssistiveWorkerConfig } from '../services/hostedAssistiveWorkerConfig';
import { runHostedAssistiveWorkerLoop } from '../services/hostedAssistiveWorkerLoop';

const COMMIT = 'a'.repeat(40);
const validEnvironment = () => ({
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'true',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging-project.supabase.co',
  CAPSTONE_ASSISTIVE_SUPABASE_URL: 'https://staging-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_worker-test',
  RENDER_INSTANCE_ID: 'srv-worker.01:instance-1',
  RENDER_GIT_COMMIT: COMMIT,
  CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR: resolve('qualified-paddle-models'),
  CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE: resolve('qualified-language', 'LanguageTool-stable.zip'),
  CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR: resolve('qualified-language', 'LanguageTool-6.6', 'languagetool-server.jar'),
});

const availabilityGateway = (response: unknown) => ({
  record: vi.fn(),
  availability: vi.fn().mockResolvedValue(response),
});

describe('hosted assistive worker configuration and availability', () => {
  it('accepts only the explicit verified staging target and frozen provider paths', () => {
    expect(getHostedAssistiveWorkerConfig(validEnvironment())).toMatchObject({
      supabaseUrl: 'https://staging-project.supabase.co',
      workerInstanceId: 'srv-worker.01:instance-1',
      deploymentVersion: COMMIT,
    });
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

  it('never queries heartbeat state for production, a mismatched host, or a disabled flag', async () => {
    for (const override of [
      { CAPSTONE_RUNTIME_ENV: 'production' },
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

  it('uses only fixed heartbeat RPC names and compatibility parameters', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { resultCode: 'AVAILABLE' }, error: null });
    const repository = new SupabaseAssistiveWorkerHeartbeatRepository({ rpc } as never, COMMIT);
    await repository.availability();
    await repository.record({ workerInstanceId: 'srv-1', deploymentVersion: COMMIT, healthState: 'READY' });
    expect(rpc.mock.calls[0]).toEqual(['get_assistive_worker_availability', {
      p_environment: ASSISTIVE_WORKER_COMPATIBILITY.environment,
      p_pipeline_version: ASSISTIVE_WORKER_COMPATIBILITY.pipelineVersion,
      p_deployment_version: COMMIT,
      p_ocr_capability: ASSISTIVE_WORKER_COMPATIBILITY.ocrCapability,
      p_language_capability: ASSISTIVE_WORKER_COMPATIBILITY.languageCapability,
      p_freshness_seconds: 60,
    }]);
    expect(rpc.mock.calls[1][0]).toBe('upsert_assistive_worker_heartbeat');
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
