import {
  LAUNCH_LIMIT_PER_ROLLING_WINDOW,
  LAUNCH_WINDOW_DAYS,
  MAX_ACTIVE_HEAVY_EXECUTIONS,
} from '../assistive-validation/domain/executionControlContract';

/**
 * Machine-verifiable zero-cost operating envelope for the on-demand assistive executor.
 *
 * Every provider value below is transcribed from official documentation with its retrieval date.
 * A human updates these only after re-reading the cited source; nothing here is derived at runtime
 * and no live pricing is scraped.
 */

export interface VerifiedProviderGrant {
  readonly provider: string;
  readonly resource: string;
  readonly vcpuSecondsPerMonth: number;
  readonly gibSecondsPerMonth: number;
  readonly scope: string;
  readonly source: string;
  readonly verifiedOn: string;
}

export const AZURE_CONTAINER_APPS_CONSUMPTION_GRANT: VerifiedProviderGrant = {
  provider: 'Microsoft Azure',
  resource: 'Container Apps Consumption plan',
  vcpuSecondsPerMonth: 180_000,
  gibSecondsPerMonth: 360_000,
  scope: 'per subscription, per calendar month',
  source: 'https://learn.microsoft.com/en-us/azure/container-apps/billing',
  verifiedOn: '2026-08-28',
};

export interface JobShape {
  readonly name: string;
  readonly triggerType: 'Schedule' | 'Manual';
  /** Five-field cron, evaluated by the provider in UTC. Schedule jobs only. */
  readonly cronExpression: string | null;
  readonly vcpu: number;
  readonly memoryGib: number;
  readonly replicaTimeoutSeconds: number;
  readonly replicaRetryLimit: number;
  readonly parallelism: number;
  readonly replicaCompletionCount: number;
  /**
   * Conservative allowance added to the replica timeout when computing the worst case, covering
   * container scheduling and image pull. Azure documents the meter as "resources allocated to each
   * replica while it's running" and documents no separate start meter, so this is a safety margin
   * rather than a transcribed provider figure.
   */
  readonly startAllowanceSeconds: number;
  /** Fixed executions per worst-case month, or null when bounded by the launch ceiling instead. */
  readonly executionsPerWorstCaseMonth: number | null;
}

/** Longest possible calendar month, used for every worst-case computation. */
export const WORST_CASE_MONTH_DAYS = 31;

export const DISPATCHER_CRON_EXPRESSION = '*/2 * * * *';

/**
 * Cadences reviewed against the arithmetic below. CI refuses any other value so a casual edit
 * cannot quietly move the envelope.
 */
export const VERIFIED_DISPATCHER_CRON_EXPRESSIONS = ['*/2 * * * *', '*/3 * * * *'] as const;

export const DISPATCHER_JOB_SHAPE: JobShape = {
  name: 'assistive-dispatcher',
  triggerType: 'Schedule',
  cronExpression: DISPATCHER_CRON_EXPRESSION,
  vcpu: 0.25,
  memoryGib: 0.5,
  replicaTimeoutSeconds: 15,
  replicaRetryLimit: 0,
  parallelism: 1,
  replicaCompletionCount: 1,
  startAllowanceSeconds: 0,
  executionsPerWorstCaseMonth: WORST_CASE_MONTH_DAYS * 24 * 30,
};

export const HEAVY_WORKER_JOB_SHAPE: JobShape = {
  name: 'assistive-worker',
  triggerType: 'Manual',
  cronExpression: null,
  vcpu: 2.0,
  memoryGib: 4.0,
  replicaTimeoutSeconds: 600,
  replicaRetryLimit: 0,
  parallelism: 1,
  replicaCompletionCount: 1,
  startAllowanceSeconds: 30,
  executionsPerWorstCaseMonth: null,
};

export interface JobUsage {
  readonly name: string;
  readonly executions: number;
  readonly billedSecondsPerExecution: number;
  readonly vcpuSeconds: number;
  readonly gibSeconds: number;
}

export function computeJobUsage(shape: JobShape, executions: number): JobUsage {
  const billedSecondsPerExecution = shape.replicaTimeoutSeconds + shape.startAllowanceSeconds;
  return {
    name: shape.name,
    executions,
    billedSecondsPerExecution,
    vcpuSeconds: executions * billedSecondsPerExecution * shape.vcpu,
    gibSeconds: executions * billedSecondsPerExecution * shape.memoryGib,
  };
}

export interface EnvelopeReport {
  readonly grant: VerifiedProviderGrant;
  readonly jobs: readonly JobUsage[];
  readonly totalVcpuSeconds: number;
  readonly totalGibSeconds: number;
  readonly vcpuUtilisation: number;
  readonly gibUtilisation: number;
  readonly withinGrant: boolean;
  /**
   * Extra seconds per dispatcher execution the configuration can absorb before the grant is
   * exceeded. Published so the sensitivity of the dispatcher line is explicit rather than implied.
   */
  readonly dispatcherStartAllowanceHeadroomSeconds: number;
}

export function computeZeroCostEnvelope(
  dispatcher: JobShape = DISPATCHER_JOB_SHAPE,
  heavy: JobShape = HEAVY_WORKER_JOB_SHAPE,
  launchLimit: number = LAUNCH_LIMIT_PER_ROLLING_WINDOW,
  grant: VerifiedProviderGrant = AZURE_CONTAINER_APPS_CONSUMPTION_GRANT,
): EnvelopeReport {
  const dispatcherExecutions = dispatcher.executionsPerWorstCaseMonth
    ?? dispatcherExecutionsForCron(dispatcher.cronExpression);
  const jobs = [
    computeJobUsage(dispatcher, dispatcherExecutions),
    computeJobUsage(heavy, launchLimit),
  ];
  const totalVcpuSeconds = jobs.reduce((sum, job) => sum + job.vcpuSeconds, 0);
  const totalGibSeconds = jobs.reduce((sum, job) => sum + job.gibSeconds, 0);

  const heavyUsage = jobs[1];
  const vcpuRemaining = grant.vcpuSecondsPerMonth - heavyUsage.vcpuSeconds;
  const gibRemaining = grant.gibSecondsPerMonth - heavyUsage.gibSeconds;
  const affordableSecondsPerDispatch = Math.min(
    vcpuRemaining / (dispatcherExecutions * dispatcher.vcpu),
    gibRemaining / (dispatcherExecutions * dispatcher.memoryGib),
  );

  return {
    grant,
    jobs,
    totalVcpuSeconds,
    totalGibSeconds,
    vcpuUtilisation: totalVcpuSeconds / grant.vcpuSecondsPerMonth,
    gibUtilisation: totalGibSeconds / grant.gibSecondsPerMonth,
    withinGrant: totalVcpuSeconds <= grant.vcpuSecondsPerMonth
      && totalGibSeconds <= grant.gibSecondsPerMonth,
    dispatcherStartAllowanceHeadroomSeconds:
      affordableSecondsPerDispatch - jobs[0].billedSecondsPerExecution,
  };
}

/** Supports only the `*​/N * * * *` minute-step form this project deploys. */
export function dispatcherExecutionsForCron(cronExpression: string | null): number {
  const match = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(cronExpression ?? '');
  if (!match) throw new Error('ZERO_COST_UNSUPPORTED_CRON_EXPRESSION');
  const step = Number.parseInt(match[1], 10);
  if (step < 1 || step > 59) throw new Error('ZERO_COST_UNSUPPORTED_CRON_EXPRESSION');
  return Math.floor((WORST_CASE_MONTH_DAYS * 24 * 60) / step);
}

/**
 * The launch-envelope facts CI asserts against the migration source, so the hard ceiling cannot
 * drift away from the database that enforces it.
 */
export const LAUNCH_ENVELOPE = {
  launchLimit: LAUNCH_LIMIT_PER_ROLLING_WINDOW,
  windowDays: LAUNCH_WINDOW_DAYS,
  maxActiveExecutions: MAX_ACTIVE_HEAVY_EXECUTIONS,
  /** Reservation states that permanently consume a unit once reached. */
  irrevocableStates: [
    'START_REQUESTED', 'START_ACCEPTED', 'START_RESPONSE_ERROR', 'START_AMBIGUOUS',
    'EXECUTION_CLAIMED', 'COMPLETED', 'FAILED', 'EXPIRED',
  ],
  /** The only state from which a unit may be released. */
  refundableState: 'PRESTART_FAILED',
  migrationPath: 'infra/supabase/migrations/20260828170000_assistive_execution_control.sql',
} as const;

/**
 * Stated wherever the envelope is reported. The verifier is a PP1 architecture guard; it cannot
 * promise that unrelated workloads in the same subscription leave the grant intact.
 */
export const SUBSCRIPTION_SCOPE_CAVEAT =
  'The free grant is per subscription. This envelope bounds PP1 usage only; a dedicated '
  + 'School-controlled subscription is required before the grant can be attributed to PP1 alone.';
