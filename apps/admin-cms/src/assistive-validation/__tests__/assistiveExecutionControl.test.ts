import { describe, expect, it, vi } from 'vitest';

import { runAssistiveDispatch } from '../services/assistiveDispatcher';
import { AzureContainerAppsJobLauncher, type ExecutorLauncher } from '../services/executorLauncher';
import { runOnDemandAssistiveWorker } from '../services/onDemandAssistiveWorkerLoop';
import { resolveAssistiveExecutionAvailability } from '../services/assistiveExecutionAvailability';
import type { AssistiveDispatchGateway } from '../repositories/assistiveDispatchRepository';
import type { AssistiveExecutionControlGateway } from '../repositories/assistiveExecutionControlRepository';
import type { CoordinatorResult } from '../services/assistiveCoordinator';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const TOKEN = '3f1d2f5a-9c4b-4f2e-8a1d-0b7c6e5d4f3a';

const budgetFacts = { launchLimit: 40, windowDays: 31, consumedInWindow: 3 };

function dispatchGateway(overrides: Record<string, unknown> = {}) {
  return {
    inspectEligibility: vi.fn().mockResolvedValue({
      resultCode: 'WORK_AVAILABLE', ...budgetFacts, activeExecutions: 0,
    }),
    reserve: vi.fn().mockResolvedValue({
      resultCode: 'RESERVED',
      reservationToken: TOKEN,
      generation: 12,
      ...budgetFacts,
      expiresAt: '2026-08-28T12:00:00.000Z',
    }),
    markRequested: vi.fn().mockResolvedValue({ resultCode: 'START_REQUESTED' }),
    recordOutcome: vi.fn().mockResolvedValue({ resultCode: 'OUTCOME_RECORDED', state: 'START_ACCEPTED' }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function launcher(overrides: Record<string, unknown> = {}) {
  return {
    prepare: vi.fn().mockResolvedValue({
      ok: true,
      prepared: { requestBody: { containers: [] }, containerName: 'assistive-worker', credential: 'token' },
    }),
    start: vi.fn().mockResolvedValue({
      outcome: 'START_ACCEPTED', executionReference: 'capstone-assistive-worker-abc123', detail: 'ACCEPTED_200',
    }),
    ...overrides,
  };
}

const dispatchInput = (gateway: unknown, executor: unknown) => ({
  // Structural fakes: the dispatcher depends on the gateway and launcher interfaces only.
  gateway: gateway as AssistiveDispatchGateway,
  launcher: executor as ExecutorLauncher,
  dispatcherInstanceId: 'capstone-assistive-dispatcher',
  deploymentVersion: COMMIT,
  imageDigest: DIGEST,
});

describe('dispatcher orchestration', () => {
  it('1. Reserves before starting and never transmits without a reservation', async () => {
    const gateway = dispatchGateway();
    const executor = launcher();
    const report = await runAssistiveDispatch(dispatchInput(gateway, executor));

    expect(report.decision).toBe('START_ACCEPTED');
    const reserveOrder = gateway.reserve.mock.invocationCallOrder[0];
    const markOrder = gateway.markRequested.mock.invocationCallOrder[0];
    const startOrder = executor.start.mock.invocationCallOrder[0];
    expect(reserveOrder).toBeLessThan(markOrder);
    expect(markOrder).toBeLessThan(startOrder);
  });

  it.each([
    ['NO_WORK'],
    ['BUDGET_EXHAUSTED'],
    ['ACTIVE_LAUNCH'],
    ['EXECUTOR_UNREGISTERED'],
  ])('2. Makes no cloud control-plane call when the probe reports %s', async (resultCode) => {
    const gateway = dispatchGateway({
      inspectEligibility: vi.fn().mockResolvedValue({
        resultCode, ...budgetFacts, activeExecutions: resultCode === 'ACTIVE_LAUNCH' ? 1 : 0,
      }),
    });
    const executor = launcher();

    const report = await runAssistiveDispatch(dispatchInput(gateway, executor));

    expect(report.decision).toBe(resultCode);
    expect(executor.prepare).not.toHaveBeenCalled();
    expect(executor.start).not.toHaveBeenCalled();
    expect(gateway.reserve).not.toHaveBeenCalled();
  });

  it('3. Treats the probe as an optimisation, never as authority', async () => {
    // The probe says work exists; the authoritative reservation disagrees and wins.
    const gateway = dispatchGateway({
      reserve: vi.fn().mockResolvedValue({ resultCode: 'BUDGET_EXHAUSTED', ...budgetFacts }),
    });
    const executor = launcher();

    const report = await runAssistiveDispatch(dispatchInput(gateway, executor));

    expect(report.decision).toBe('BUDGET_EXHAUSTED');
    expect(executor.start).not.toHaveBeenCalled();
  });

  it('4. Consumes nothing when the preflight fails before any reservation exists', async () => {
    const gateway = dispatchGateway();
    const executor = launcher({
      prepare: vi.fn().mockResolvedValue({ ok: false, reason: 'JOB_IMAGE_DIGEST_MISMATCH' }),
    });

    const report = await runAssistiveDispatch(dispatchInput(gateway, executor));

    expect(report).toMatchObject({ decision: 'PREPARE_FAILED', detail: 'JOB_IMAGE_DIGEST_MISMATCH' });
    expect(gateway.reserve).not.toHaveBeenCalled();
    expect(gateway.recordOutcome).not.toHaveBeenCalled();
  });

  it('5. Releases the unit only when the durable pre-transmission mark is fenced', async () => {
    const gateway = dispatchGateway({
      markRequested: vi.fn().mockResolvedValue({ resultCode: 'FENCED' }),
    });
    const executor = launcher();

    const report = await runAssistiveDispatch(dispatchInput(gateway, executor));

    expect(report.decision).toBe('RESERVATION_FENCED');
    expect(executor.start).not.toHaveBeenCalled();
    expect(gateway.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'PRESTART_FAILED' }),
    );
  });

  it.each([
    ['START_RESPONSE_ERROR', 'HTTP_403'],
    ['START_AMBIGUOUS', 'TRANSPORT_FAILURE'],
  ])('6. Keeps the unit consumed after transmission when the result is %s', async (outcome, detail) => {
    const gateway = dispatchGateway();
    const executor = launcher({
      start: vi.fn().mockResolvedValue({ outcome, executionReference: null, detail }),
    });

    const report = await runAssistiveDispatch(dispatchInput(gateway, executor));

    expect(report.decision).toBe(outcome);
    expect(gateway.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
    expect(gateway.recordOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'PRESTART_FAILED' }),
    );
  });

  it('7. Reports only a truncated reservation token', async () => {
    const report = await runAssistiveDispatch(dispatchInput(dispatchGateway(), launcher()));
    expect(report.reservationToken).toBe('3f1d2f5a…');
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('8. Fails closed on a malformed execution-control response', async () => {
    const gateway = dispatchGateway({
      inspectEligibility: vi.fn().mockResolvedValue({ resultCode: 'SOMETHING_ELSE' }),
    });
    const report = await runAssistiveDispatch(dispatchInput(gateway, launcher()));
    expect(report).toMatchObject({ decision: 'VALIDATION_FAILED', detail: 'PROBE_CONTRACT_REJECTED' });
  });
});

describe('cloud execution adapter', () => {
  const launcherConfig = {
    identityEndpoint: 'http://localhost:42356/msi/token',
    identityHeader: 'header-value',
    managedIdentityClientId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    subscriptionId: '11111111-2222-4333-8444-555555555555',
    resourceGroup: 'rg-capstone-assistive',
    jobName: 'capstone-assistive-worker',
    expectedDeploymentVersion: COMMIT,
    expectedImageDigest: DIGEST,
  };

  const jobTemplate = {
    properties: {
      template: {
        containers: [{
          name: 'assistive-worker',
          image: `ghcr.io/example/capstone-assistive-worker@${DIGEST}`,
          command: ['npm', 'run', 'run:assistive-worker:on-demand', '--workspace=apps/admin-cms'],
          args: ['--quiet'],
          resources: { cpu: 2, memory: '4.0Gi' },
          env: [
            { name: 'CAPSTONE_RUNTIME_ENV', value: 'staging' },
            { name: 'CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED', value: 'true' },
            { name: 'CAPSTONE_ASSISTIVE_EXECUTION_MODE', value: 'ON_DEMAND' },
            { name: 'CAPSTONE_DEPLOYMENT_VERSION', value: COMMIT },
            { name: 'CAPSTONE_ASSISTIVE_IMAGE_DIGEST', value: DIGEST },
            { name: 'CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID', value: 'capstone-assistive-worker' },
            { name: 'SUPABASE_SECRET_KEY', secretRef: 'supabase-secret-key' },
          ],
          probes: [{ type: 'liveness', tcpSocket: { port: 3000 }, initialDelaySeconds: 5 }],
          volumeMounts: [{ volumeName: 'scratch', mountPath: '/scratch' }],
        }],
        initContainers: [{
          name: 'init',
          image: 'ghcr.io/example/init@sha256:cafe',
          args: ['--prepare'],
          env: [{ name: 'INIT_SECRET', secretRef: 'init-secret' }],
          resources: { cpu: 0.25 },
          volumeMounts: [{ volumeName: 'scratch', mountPath: '/scratch' }],
        }],
        volumes: [{ name: 'scratch', storageType: 'EmptyDir' }],
        terminationGracePeriodSeconds: 60,
      },
    },
  };

  function fetchStub(handlers: {
    token?: () => Response | Promise<Response>;
    read?: () => Response | Promise<Response>;
    start?: (body: unknown) => Response | Promise<Response>;
  }) {
    const startBodies: unknown[] = [];
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/msi/token')) {
        return handlers.token?.() ?? Response.json({ access_token: 'arm-token' });
      }
      if (href.endsWith('/start?api-version=2026-01-01')) {
        const body = JSON.parse(String(init?.body));
        startBodies.push(body);
        return handlers.start?.(body) ?? Response.json({ name: 'capstone-assistive-worker-abc123' });
      }
      return handlers.read?.() ?? Response.json(jobTemplate);
    });
    return { impl: impl as unknown as typeof fetch, startBodies };
  }

  it('9. Preserves the complete deployed template and injects only reservation variables', async () => {
    const { impl, startBodies } = fetchStub({});
    const adapter = new AzureContainerAppsJobLauncher(launcherConfig, impl);

    const prepared = await adapter.prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await adapter.start(prepared.prepared, TOKEN, 12);

    const expected = structuredClone(jobTemplate.properties.template);
    expected.containers[0].env = [
      ...expected.containers[0].env,
      { name: 'CAPSTONE_ASSISTIVE_RESERVATION_TOKEN', value: TOKEN },
      { name: 'CAPSTONE_ASSISTIVE_RESERVATION_GENERATION', value: '12' },
    ];
    expect(startBodies).toEqual([expected]);
  });

  it('10. Accepts a job-scoped worker identity that deliberately differs from the container name', async () => {
    expect(jobTemplate.properties.template.containers[0].name).toBe('assistive-worker');
    expect(jobTemplate.properties.template.containers[0].env).toContainEqual({
      name: 'CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID', value: launcherConfig.jobName,
    });
    const { impl } = fetchStub({});
    await expect(new AzureContainerAppsJobLauncher(launcherConfig, impl).prepare())
      .resolves.toMatchObject({ ok: true });
  });

  it('10a. Refuses a container-scoped identity in place of the configured job identity', async () => {
    const drifted = structuredClone(jobTemplate);
    const workerIdentity = drifted.properties.template.containers[0].env
      .find((entry) => entry.name === 'CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID');
    if (workerIdentity) workerIdentity.value = 'assistive-worker';
    const { impl } = fetchStub({ read: () => Response.json(drifted) });
    await expect(new AzureContainerAppsJobLauncher(launcherConfig, impl).prepare())
      .resolves.toEqual({ ok: false, reason: 'JOB_TEMPLATE_INVALID' });
  });

  it.each([
    ['a missing identity token', { token: () => new Response('no', { status: 500 }) }, 'IDENTITY_TOKEN_UNAVAILABLE'],
    ['an unreadable job', { read: () => new Response('no', { status: 403 }) }, 'JOB_READ_FAILED_403'],
  ])('10. Reports %s as a refundable pre-transmission failure', async (_label, handlers, reason) => {
    const { impl } = fetchStub(handlers);
    const result = await new AzureContainerAppsJobLauncher(launcherConfig, impl).prepare();
    expect(result).toEqual({ ok: false, reason });
  });

  it('11. Refuses to prepare a job whose image is not the expected digest', async () => {
    const { impl } = fetchStub({
      read: () => Response.json({
        properties: { template: { containers: [{ name: 'assistive-worker', image: 'ghcr.io/example/worker:latest' }] } },
      }),
    });
    const result = await new AzureContainerAppsJobLauncher(launcherConfig, impl).prepare();
    expect(result).toEqual({ ok: false, reason: 'JOB_IMAGE_DIGEST_MISMATCH' });
  });

  it('11a. Refuses to prepare a job whose deployment SHA is not the expected commit', async () => {
    const mismatched = structuredClone(jobTemplate);
    const deployment = mismatched.properties.template.containers[0].env
      .find((entry) => entry.name === 'CAPSTONE_DEPLOYMENT_VERSION');
    if (deployment) deployment.value = 'c'.repeat(40);
    const { impl } = fetchStub({ read: () => Response.json(mismatched) });
    const result = await new AzureContainerAppsJobLauncher(launcherConfig, impl).prepare();
    expect(result).toEqual({ ok: false, reason: 'JOB_DEPLOYMENT_MISMATCH' });
  });

  it('11b. Refuses an incomplete or drifted heavy-job template', async () => {
    const drifted = structuredClone(jobTemplate);
    drifted.properties.template.containers[0].resources.cpu = 1;
    const { impl } = fetchStub({ read: () => Response.json(drifted) });
    const result = await new AzureContainerAppsJobLauncher(launcherConfig, impl).prepare();
    expect(result).toEqual({ ok: false, reason: 'JOB_TEMPLATE_INVALID' });
  });

  it.each([
    ['200 with a name', () => Response.json({ name: 'exec-1' }), 'START_ACCEPTED', 'exec-1'],
    ['202 accepted', () => new Response(null, { status: 202 }), 'START_ACCEPTED', null],
    ['409 conflict', () => new Response('conflict', { status: 409 }), 'START_RESPONSE_ERROR', null],
    ['429 throttling', () => new Response('slow down', { status: 429 }), 'START_RESPONSE_ERROR', null],
    ['500 failure', () => new Response('boom', { status: 500 }), 'START_RESPONSE_ERROR', null],
    ['an unreadable body', () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }), 'START_AMBIGUOUS', null],
  ])('12. Maps %s to a post-transmission outcome', async (_label, start, outcome, reference) => {
    const { impl } = fetchStub({ start });
    const adapter = new AzureContainerAppsJobLauncher(launcherConfig, impl);
    const prepared = await adapter.prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const result = await adapter.start(prepared.prepared, TOKEN, 12);
    expect(result.outcome).toBe(outcome);
    expect(result.executionReference).toBe(reference);
  });

  it('13. Maps a transport failure after transmission to an ambiguous outcome', async () => {
    const { impl } = fetchStub({ start: () => { throw new Error('socket hang up'); } });
    const adapter = new AzureContainerAppsJobLauncher(launcherConfig, impl);
    const prepared = await adapter.prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await expect(adapter.start(prepared.prepared, TOKEN, 12)).resolves.toMatchObject({
      outcome: 'START_AMBIGUOUS', detail: 'TRANSPORT_FAILURE',
    });
  });
});

describe('on-demand worker', () => {
  const identity = { workerInstanceId: 'capstone-assistive-worker', deploymentVersion: COMMIT, imageDigest: DIGEST };
  const reservation = { token: TOKEN, generation: 12 };

  function control(claimResult: unknown = { resultCode: 'CLAIMED', expiresAt: '2026-08-28T12:00:00.000Z' }) {
    return {
      register: vi.fn(),
      claim: vi.fn().mockResolvedValue(claimResult),
      settle: vi.fn().mockResolvedValue({ resultCode: 'SETTLED', state: 'COMPLETED' }),
      availability: vi.fn(),
    } as unknown as AssistiveExecutionControlGateway & Record<string, ReturnType<typeof vi.fn>>;
  }

  const heartbeat = () => ({ publish: vi.fn().mockResolvedValue(undefined) });

  const runtime = (
    health = vi.fn().mockResolvedValue(true),
    runOnce = vi.fn(),
    beat = heartbeat(),
  ) => ({ health, runOnce, heartbeat: beat });

  it('14. Claims before any provider is constructed and exits when refused', async () => {
    const gateway = control({ resultCode: 'CLAIM_REFUSED' });
    const health = vi.fn().mockResolvedValue(true);
    const runOnce = vi.fn();
    const beat = heartbeat();
    const createRuntime = vi.fn(() => runtime(health, runOnce, beat));

    const result = await runOnDemandAssistiveWorker({
      signal: new AbortController().signal,
      reservation,
      identity,
      control: gateway,
      createRuntime,
    });

    expect(result).toEqual({ outcome: 'CLAIM_REFUSED', processedJobCount: 0 });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
    expect(beat.publish).not.toHaveBeenCalled();
    expect(gateway.settle).not.toHaveBeenCalled();
  });

  it('15. Drains multiple queued jobs in one execution and settles once', async () => {
    const gateway = control();
    const results: CoordinatorResult[] = [
      { outcome: 'FINALIZED', runId: '1' },
      { outcome: 'PARTIAL', runId: '2' },
      { outcome: 'EMPTY' },
    ];
    const runOnce = vi.fn(async () => results.shift() ?? { outcome: 'EMPTY' as const });
    const beat = heartbeat();

    const result = await runOnDemandAssistiveWorker({
      signal: new AbortController().signal,
      reservation,
      identity,
      control: gateway,
      createRuntime: () => runtime(vi.fn().mockResolvedValue(true), runOnce, beat),
    });

    expect(result).toEqual({ outcome: 'DRAINED', processedJobCount: 2 });
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(beat.publish.mock.calls.map(([state]) => state)).toEqual(['READY', 'STOPPING']);
    expect(gateway.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'COMPLETED', processedJobCount: 2, generation: 12,
    }));
  });

  it('16. Stops at the runtime budget and leaves remaining work queued', async () => {
    let elapsed = 0;
    const result = await runOnDemandAssistiveWorker({
      signal: new AbortController().signal,
      reservation,
      identity,
      control: control(),
      createRuntime: () => runtime(
        vi.fn().mockResolvedValue(true),
        vi.fn(async () => { elapsed += 200_000; return { outcome: 'FINALIZED' as const, runId: 'x' }; }),
      ),
      runtimeBudgetMs: 480_000,
      now: () => elapsed,
    });
    expect(result).toEqual({ outcome: 'RUNTIME_BUDGET_REACHED', processedJobCount: 3 });
  });

  it('17. Stops promptly on shutdown and still settles the reservation', async () => {
    const controller = new AbortController();
    const gateway = control();
    const result = await runOnDemandAssistiveWorker({
      signal: controller.signal,
      reservation,
      identity,
      control: gateway,
      createRuntime: () => runtime(
        vi.fn().mockResolvedValue(true),
        vi.fn(async () => { controller.abort(); return { outcome: 'FINALIZED' as const, runId: 'x' }; }),
      ),
    });
    expect(result).toEqual({ outcome: 'SHUTDOWN_REQUESTED', processedJobCount: 1 });
    expect(gateway.settle).toHaveBeenCalled();
  });

  it('18. Reports a failed preflight without claiming queue work', async () => {
    const gateway = control();
    const runOnce = vi.fn();
    const result = await runOnDemandAssistiveWorker({
      signal: new AbortController().signal,
      reservation,
      identity,
      control: gateway,
      createRuntime: () => runtime(vi.fn().mockResolvedValue(false), runOnce),
    });
    expect(result).toEqual({ outcome: 'PREFLIGHT_FAILED', processedJobCount: 0 });
    expect(runOnce).not.toHaveBeenCalled();
    expect(gateway.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILED' }));
  });

  it('18a. Settles failure when provider runtime construction throws after a valid claim', async () => {
    const gateway = control();
    await expect(runOnDemandAssistiveWorker({
      signal: new AbortController().signal,
      reservation,
      identity,
      control: gateway,
      createRuntime: () => { throw new Error('provider construction failed'); },
    })).rejects.toThrow('provider construction failed');
    expect(gateway.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILED' }));
  });
});

describe('staff-facing availability', () => {
  const stagingEnvironment = {
    CAPSTONE_RUNTIME_ENV: 'staging',
    CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED: 'true',
    CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging-project.supabase.co',
    CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION: COMMIT,
    CAPSTONE_ASSISTIVE_EXPECTED_WORKER_IMAGE_DIGEST: DIGEST,
  };
  const url = 'https://staging-project.supabase.co';

  const heartbeatGateway = (available: boolean) => ({
    record: vi.fn(),
    availability: vi.fn().mockResolvedValue(available
      ? { resultCode: 'AVAILABLE', compatibleWorkerCount: 1, latestHeartbeatAt: '2026-08-28T12:00:00.000Z' }
      : { resultCode: 'UNAVAILABLE', compatibleWorkerCount: 0, latestHeartbeatAt: null }),
  });

  const controlGateway = (response: unknown) => ({
    register: vi.fn(), claim: vi.fn(), settle: vi.fn(),
    availability: vi.fn().mockResolvedValue(response),
  }) as unknown as AssistiveExecutionControlGateway;

  const availabilityPayload = (resultCode: string) => ({
    resultCode,
    executionMode: 'ON_DEMAND',
    launchLimit: 40,
    windowDays: 31,
    consumedInWindow: resultCode === 'BUDGET_EXHAUSTED' ? 40 : 3,
    remainingInWindow: resultCode === 'BUDGET_EXHAUSTED' ? 0 : 37,
    activeExecutions: 0,
    utcCalendarMonthStarts: 3,
    lastExecutionAt: null,
    registrationExpiresAt: '2026-09-27T00:00:00.000Z',
  });

  it('19. Reports local loopback execution without consulting any hosted evidence', async () => {
    await expect(resolveAssistiveExecutionAvailability('http://127.0.0.1:54321'))
      .resolves.toEqual({ state: 'LOCAL_READY', canEnqueue: true, message: null });
  });

  it('20. Prefers a fresh continuous worker heartbeat', async () => {
    await expect(resolveAssistiveExecutionAvailability(
      url, heartbeatGateway(true), controlGateway(availabilityPayload('AVAILABLE')), stagingEnvironment,
    )).resolves.toMatchObject({ state: 'READY', canEnqueue: true });
  });

  it('21. Falls back to a registered on-demand executor with capacity remaining', async () => {
    await expect(resolveAssistiveExecutionAvailability(
      url, heartbeatGateway(false), controlGateway(availabilityPayload('AVAILABLE')), stagingEnvironment,
    )).resolves.toEqual({ state: 'ON_DEMAND_READY', canEnqueue: true, message: null });
  });

  it('22. Tells staff plainly when the processing limit is reached', async () => {
    const availability = await resolveAssistiveExecutionAvailability(
      url, heartbeatGateway(false), controlGateway(availabilityPayload('BUDGET_EXHAUSTED')), stagingEnvironment,
    );
    expect(availability.state).toBe('BUDGET_REACHED');
    expect(availability.canEnqueue).toBe(false);
    expect(availability.message).toMatch(/continue reviewing and editing project information manually/);
  });

  it.each([
    ['an unregistered executor', availabilityPayload('UNAVAILABLE')],
    ['a rejected identity', { resultCode: 'VALIDATION_FAILED' }],
    ['a malformed response', { resultCode: 'SOMETHING_ELSE' }],
  ])('23. Fails closed on %s', async (_label, response) => {
    await expect(resolveAssistiveExecutionAvailability(
      url, heartbeatGateway(false), controlGateway(response), stagingEnvironment,
    )).resolves.toMatchObject({ state: 'TEMPORARILY_UNAVAILABLE', canEnqueue: false });
  });

  it('24. Fails closed when the expected worker identity is not configured', async () => {
    await expect(resolveAssistiveExecutionAvailability(
      url,
      heartbeatGateway(false),
      controlGateway(availabilityPayload('AVAILABLE')),
      { ...stagingEnvironment, CAPSTONE_ASSISTIVE_EXPECTED_WORKER_IMAGE_DIGEST: undefined },
    )).resolves.toMatchObject({ state: 'TEMPORARILY_UNAVAILABLE', canEnqueue: false });
  });
});
