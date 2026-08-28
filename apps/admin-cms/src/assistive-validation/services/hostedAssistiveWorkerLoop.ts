import { ASSISTIVE_WORKER_HEARTBEAT_INTERVAL_MS } from '../domain/workerHeartbeatContract';
import type { CoordinatorResult } from './assistiveCoordinator';
import type { AssistiveWorkerHeartbeatPublisher } from './assistiveWorkerHeartbeat';

interface HostedAssistiveWorkerLoopInput {
  signal: AbortSignal;
  health: () => Promise<boolean>;
  runOnce: () => Promise<CoordinatorResult>;
  heartbeat: Pick<AssistiveWorkerHeartbeatPublisher, 'publish'>;
  idleDelayMs?: number;
  heartbeatIntervalMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  report?: (result: CoordinatorResult) => void;
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function runHostedAssistiveWorkerLoop(input: HostedAssistiveWorkerLoopInput): Promise<void> {
  if (!(await input.health())) throw new Error('ASSISTIVE_WORKER_PREFLIGHT_FAILED');
  if (input.signal.aborted) return;

  await input.heartbeat.publish('READY');
  let heartbeatFailure: unknown = null;
  let pendingHeartbeat: Promise<void> | null = null;
  const heartbeatTimer = setInterval(() => {
    if (pendingHeartbeat || input.signal.aborted) return;
    const publication = input.heartbeat.publish('READY')
      .catch((error) => { heartbeatFailure = error; });
    pendingHeartbeat = publication;
    void publication.finally(() => {
      if (pendingHeartbeat === publication) pendingHeartbeat = null;
    });
  }, input.heartbeatIntervalMs ?? ASSISTIVE_WORKER_HEARTBEAT_INTERVAL_MS);

  try {
    while (!input.signal.aborted) {
      if (heartbeatFailure) throw new Error('ASSISTIVE_WORKER_HEARTBEAT_FAILED');
      const result = await input.runOnce();
      input.report?.(result);
      if (result.outcome === 'EMPTY' && !input.signal.aborted) {
        await (input.wait ?? waitFor)(input.idleDelayMs ?? 2_000, input.signal);
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    if (pendingHeartbeat) await pendingHeartbeat;
    try {
      await input.heartbeat.publish('STOPPING');
    } catch {
      // A failed final heartbeat becomes stale and unavailable within the fixed freshness window.
    }
  }
}
