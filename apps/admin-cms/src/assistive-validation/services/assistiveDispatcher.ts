import {
  launchEligibilityResponseSchema,
  launchOutcomeResponseSchema,
  launchRequestedResponseSchema,
  launchReservationResponseSchema,
  redactReservationToken,
} from '../domain/executionControlContract';
import type { AssistiveDispatchGateway } from '../repositories/assistiveDispatchRepository';
import type { ExecutorLauncher } from './executorLauncher';

/**
 * Scheduled dispatcher orchestration.
 *
 * The invariant this exists to protect: a unit of the launch ceiling is reserved in the database
 * *before* any start request can be transmitted, and once the request has been transmitted the
 * unit is never released. The cheap eligibility probe in front is an optimisation that keeps the
 * empty-queue path free of cloud control-plane traffic; it is never authority, and every condition
 * it reports is rechecked inside the reservation itself.
 *
 * This module performs no OCR, no language checking, no project metadata mutation, no publication,
 * and exposes no inbound interface.
 */

export type DispatchDecision =
  | 'NO_WORK'
  | 'BUDGET_EXHAUSTED'
  | 'ACTIVE_LAUNCH'
  | 'EXECUTOR_UNREGISTERED'
  | 'PREPARE_FAILED'
  | 'RESERVATION_FENCED'
  | 'VALIDATION_FAILED'
  | 'START_ACCEPTED'
  | 'START_RESPONSE_ERROR'
  | 'START_AMBIGUOUS';

export interface DispatchReport {
  readonly decision: DispatchDecision;
  /** Truncated. A full reservation token is never written to any log or report. */
  readonly reservationToken: string | null;
  readonly generation: number | null;
  readonly launchLimit: number | null;
  readonly windowDays: number | null;
  readonly consumedInWindow: number | null;
  readonly detail: string | null;
}

export interface DispatchInput {
  readonly gateway: AssistiveDispatchGateway;
  readonly launcher: ExecutorLauncher;
  readonly dispatcherInstanceId: string;
  readonly deploymentVersion: string;
  readonly imageDigest: string;
}

function report(decision: DispatchDecision, extra: Partial<DispatchReport> = {}): DispatchReport {
  return {
    decision,
    reservationToken: null,
    generation: null,
    launchLimit: null,
    windowDays: null,
    consumedInWindow: null,
    detail: null,
    ...extra,
  };
}

export async function runAssistiveDispatch(input: DispatchInput): Promise<DispatchReport> {
  const eligibility = launchEligibilityResponseSchema.safeParse(
    await input.gateway.inspectEligibility(),
  );
  if (!eligibility.success) return report('VALIDATION_FAILED', { detail: 'PROBE_CONTRACT_REJECTED' });
  if (eligibility.data.resultCode !== 'WORK_AVAILABLE') {
    return report(eligibility.data.resultCode, {
      launchLimit: 'launchLimit' in eligibility.data ? eligibility.data.launchLimit : null,
      windowDays: 'windowDays' in eligibility.data ? eligibility.data.windowDays : null,
      consumedInWindow: 'consumedInWindow' in eligibility.data
        ? eligibility.data.consumedInWindow
        : null,
    });
  }

  // Everything that can fail without transmitting a request happens before the reservation, so a
  // preflight failure costs nothing at all.
  const prepared = await input.launcher.prepare();
  if (!prepared.ok) return report('PREPARE_FAILED', { detail: prepared.reason });

  const reservation = launchReservationResponseSchema.safeParse(await input.gateway.reserve({
    dispatcherInstanceId: input.dispatcherInstanceId,
    deploymentVersion: input.deploymentVersion,
    imageDigest: input.imageDigest,
  }));
  if (!reservation.success) {
    return report('VALIDATION_FAILED', { detail: 'RESERVATION_CONTRACT_REJECTED' });
  }
  if (reservation.data.resultCode !== 'RESERVED') {
    return report(reservation.data.resultCode, {
      launchLimit: 'launchLimit' in reservation.data ? reservation.data.launchLimit : null,
      windowDays: 'windowDays' in reservation.data ? reservation.data.windowDays : null,
      consumedInWindow: 'consumedInWindow' in reservation.data
        ? reservation.data.consumedInWindow
        : null,
    });
  }
  const { reservationToken, generation, launchLimit, windowDays, consumedInWindow } = reservation.data;
  const identity = {
    reservationToken: redactReservationToken(reservationToken),
    generation,
    launchLimit,
    windowDays,
    consumedInWindow,
  };

  // Point of no refund. Written durably before transmission so a dispatcher that dies at any later
  // point still leaves the unit consumed.
  const requested = launchRequestedResponseSchema.safeParse(await input.gateway.markRequested({
    reservationToken,
    generation,
  }));
  if (!requested.success || requested.data.resultCode !== 'START_REQUESTED') {
    // Nothing was transmitted, so this reservation is safely refundable.
    await input.gateway.recordOutcome({
      reservationToken,
      generation,
      outcome: 'PRESTART_FAILED',
      executionReference: null,
    }).catch(() => undefined);
    return report('RESERVATION_FENCED', { ...identity, detail: 'MARK_REQUESTED_FENCED' });
  }

  const started = await input.launcher.start(prepared.prepared, reservationToken, generation);
  const recorded = launchOutcomeResponseSchema.safeParse(await input.gateway.recordOutcome({
    reservationToken,
    generation,
    outcome: started.outcome,
    executionReference: started.executionReference,
  }));

  return report(started.outcome, {
    ...identity,
    detail: recorded.success && recorded.data.resultCode === 'OUTCOME_RECORDED'
      ? started.detail
      : `${started.detail}/OUTCOME_NOT_RECORDED`,
  });
}
