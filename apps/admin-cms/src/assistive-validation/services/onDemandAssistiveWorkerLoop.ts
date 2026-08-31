import {
  executionClaimResponseSchema,
  executionSettlementResponseSchema,
  ON_DEMAND_RUNTIME_BUDGET_MS,
} from '../domain/executionControlContract';
import type { AssistiveExecutionControlGateway } from '../repositories/assistiveExecutionControlRepository';
import type { CoordinatorResult } from './assistiveCoordinator';
import type { AssistiveWorkerHeartbeatPublisher } from './assistiveWorkerHeartbeat';

/**
 * Scale-to-zero drain loop.
 *
 * The claim is the first application action and happens before any provider is constructed, so an
 * execution that was not authorised by the dispatcher — a portal "Run now", a duplicate, a stale
 * replay, or a mismatched deployment — exits without loading PaddleOCR or LanguageTool and without
 * touching the queue.
 *
 * Queue fencing is unchanged: claimed jobs keep their existing lease, rotated claim token,
 * cancellation checks, and attempt bound. This loop only decides how long to keep draining.
 */

export type OnDemandOutcome =
  | 'CLAIM_REFUSED'
  | 'PREFLIGHT_FAILED'
  | 'EXECUTION_FAILED'
  | 'DRAINED'
  | 'RUNTIME_BUDGET_REACHED'
  | 'SHUTDOWN_REQUESTED';

export interface OnDemandWorkerResult {
  readonly outcome: OnDemandOutcome;
  readonly processedJobCount: number;
}

export interface OnDemandWorkerInput {
  readonly signal: AbortSignal;
  readonly reservation: { token: string; generation: number };
  readonly identity: {
    workerInstanceId: string;
    deploymentVersion: string;
    imageDigest: string;
  };
  readonly control: AssistiveExecutionControlGateway;
  /** Constructed only after the database has accepted the reservation claim. */
  readonly createRuntime: () => {
    readonly health: () => Promise<boolean>;
    readonly runOnce: () => Promise<CoordinatorResult>;
    readonly heartbeat: Pick<AssistiveWorkerHeartbeatPublisher, 'publish'>;
    readonly report?: (result: CoordinatorResult) => void;
  };
  readonly runtimeBudgetMs?: number;
  readonly now?: () => number;
}

export async function runOnDemandAssistiveWorker(
  input: OnDemandWorkerInput,
): Promise<OnDemandWorkerResult> {
  const claim = executionClaimResponseSchema.safeParse(await input.control.claim({
    reservationToken: input.reservation.token,
    generation: input.reservation.generation,
    workerInstanceId: input.identity.workerInstanceId,
    deploymentVersion: input.identity.deploymentVersion,
    imageDigest: input.identity.imageDigest,
    executionMode: 'ON_DEMAND',
  }));
  if (!claim.success || claim.data.resultCode !== 'CLAIMED') {
    return { outcome: 'CLAIM_REFUSED', processedJobCount: 0 };
  }

  const now = input.now ?? Date.now;
  const deadline = now() + (input.runtimeBudgetMs ?? ON_DEMAND_RUNTIME_BUDGET_MS);
  let processedJobCount = 0;
  let outcome: OnDemandOutcome = 'EXECUTION_FAILED';
  let runtime: ReturnType<OnDemandWorkerInput['createRuntime']> | null = null;

  try {
    runtime = input.createRuntime();
    if (!(await runtime.health())) {
      outcome = 'PREFLIGHT_FAILED';
      return { outcome, processedJobCount };
    }

    await runtime.heartbeat.publish('READY');
    outcome = 'DRAINED';

    while (!input.signal.aborted) {
      if (now() >= deadline) {
        outcome = 'RUNTIME_BUDGET_REACHED';
        break;
      }
      const result = await runtime.runOnce();
      runtime.report?.(result);
      if (result.outcome === 'EMPTY') {
        outcome = 'DRAINED';
        break;
      }
      processedJobCount += 1;
    }
    if (input.signal.aborted && outcome === 'DRAINED') outcome = 'SHUTDOWN_REQUESTED';

    return { outcome, processedJobCount };
  } catch (error) {
    outcome = 'EXECUTION_FAILED';
    throw error;
  } finally {
    if (runtime) {
      try {
        await runtime.heartbeat.publish('STOPPING');
      } catch {
        // A failed final heartbeat becomes stale and unavailable within the fixed freshness window.
      }
    }
    try {
      executionSettlementResponseSchema.parse(await input.control.settle({
        reservationToken: input.reservation.token,
        generation: input.reservation.generation,
        outcome: outcome === 'PREFLIGHT_FAILED' || outcome === 'EXECUTION_FAILED'
          ? 'FAILED'
          : 'COMPLETED',
        processedJobCount: Math.min(processedJobCount, 1000),
      }));
    } catch {
      // Settlement is evidence only. The reservation expires within its fixed window either way,
      // and the consumed unit is never released by an unsettled execution.
    }
  }
}
