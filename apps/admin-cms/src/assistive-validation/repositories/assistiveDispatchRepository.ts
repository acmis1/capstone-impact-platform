import { RESERVATION_TTL_SECONDS, type LaunchOutcome } from '../domain/executionControlContract';

/**
 * Dispatcher-side execution-control surface.
 *
 * This is the only part of PP1 that reaches PostgreSQL directly rather than through PostgREST,
 * because the dispatcher must authenticate as its own least-privilege database role. That role can
 * execute exactly the four routines below and nothing else: no table privileges, no project data,
 * no workflow or publication routine, and no service-role credential.
 */
export interface AssistiveDispatchGateway {
  inspectEligibility(): Promise<unknown>;
  reserve(input: {
    dispatcherInstanceId: string;
    deploymentVersion: string;
    imageDigest: string;
  }): Promise<unknown>;
  markRequested(input: { reservationToken: string; generation: number }): Promise<unknown>;
  recordOutcome(input: {
    reservationToken: string;
    generation: number;
    outcome: LaunchOutcome;
    executionReference: string | null;
  }): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal surface of the `pg` client this repository needs, so tests need no live database. */
export interface DispatchSqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

const INSPECT_SQL =
  'SELECT assistive_execution_control.inspect_assistive_launch_eligibility() AS result';
const RESERVE_SQL =
  'SELECT assistive_execution_control.reserve_assistive_launch($1, $2, $3, $4) AS result';
const MARK_REQUESTED_SQL =
  'SELECT assistive_execution_control.mark_assistive_launch_requested($1, $2) AS result';
const RECORD_OUTCOME_SQL =
  'SELECT assistive_execution_control.record_assistive_launch_outcome($1, $2, $3, $4) AS result';

export class PostgresAssistiveDispatchRepository implements AssistiveDispatchGateway {
  constructor(private readonly client: DispatchSqlClient) {}

  private async call(text: string, values: unknown[] = []): Promise<unknown> {
    let rows: Array<Record<string, unknown>>;
    try {
      ({ rows } = await this.client.query(text, values));
    } catch {
      throw new Error('ASSISTIVE_DISPATCH_QUERY_FAILED');
    }
    if (rows.length !== 1) throw new Error('ASSISTIVE_DISPATCH_QUERY_FAILED');
    return rows[0].result;
  }

  inspectEligibility() {
    return this.call(INSPECT_SQL);
  }

  reserve(input: Parameters<AssistiveDispatchGateway['reserve']>[0]) {
    return this.call(RESERVE_SQL, [
      input.dispatcherInstanceId,
      input.deploymentVersion,
      input.imageDigest,
      RESERVATION_TTL_SECONDS,
    ]);
  }

  markRequested(input: Parameters<AssistiveDispatchGateway['markRequested']>[0]) {
    return this.call(MARK_REQUESTED_SQL, [input.reservationToken, input.generation]);
  }

  recordOutcome(input: Parameters<AssistiveDispatchGateway['recordOutcome']>[0]) {
    return this.call(RECORD_OUTCOME_SQL, [
      input.reservationToken,
      input.generation,
      input.outcome,
      input.executionReference,
    ]);
  }

  async close(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      // A failed disconnect cannot change committed execution-control state.
    }
  }
}
