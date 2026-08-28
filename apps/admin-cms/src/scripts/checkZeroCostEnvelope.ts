import fs from 'node:fs';
import path from 'node:path';

import {
  computeZeroCostEnvelope,
  DISPATCHER_JOB_SHAPE,
  HEAVY_WORKER_JOB_SHAPE,
  LAUNCH_ENVELOPE,
  SUBSCRIPTION_SCOPE_CAVEAT,
  VERIFIED_DISPATCHER_CRON_EXPRESSIONS,
} from '../operations/zeroCostExecutionEnvelope';

/**
 * Zero-cost architecture guard.
 *
 * Proves two things from source, without contacting any provider: the configured compute envelope
 * fits inside the verified free grant, and the launch ceiling that bounds billable starts is still
 * enforced by the database rather than by configuration.
 *
 * It is not a promise that the subscription bill is zero. See the caveat printed at the end.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

export interface EnvelopeCheckResult {
  readonly failures: string[];
  readonly lines: string[];
}

function readIfPresent(relativePath: string): string | null {
  const full = path.join(repoRoot, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function checkComputeEnvelope(failures: string[], lines: string[]): void {
  if (!VERIFIED_DISPATCHER_CRON_EXPRESSIONS.includes(
    DISPATCHER_JOB_SHAPE.cronExpression as (typeof VERIFIED_DISPATCHER_CRON_EXPRESSIONS)[number],
  )) {
    failures.push(
      `Dispatcher cron "${DISPATCHER_JOB_SHAPE.cronExpression}" is outside the reviewed set `
      + `[${VERIFIED_DISPATCHER_CRON_EXPRESSIONS.join(', ')}].`,
    );
  }
  for (const shape of [DISPATCHER_JOB_SHAPE, HEAVY_WORKER_JOB_SHAPE]) {
    if (shape.parallelism !== 1 || shape.replicaCompletionCount !== 1) {
      failures.push(`Job "${shape.name}" must keep parallelism and completion count at 1.`);
    }
    if (shape.replicaRetryLimit !== 0) {
      failures.push(`Job "${shape.name}" must not retry: a retry is another billable start.`);
    }
    if (shape.memoryGib !== shape.vcpu * 2) {
      failures.push(`Job "${shape.name}" is not a supported Consumption vCPU/memory pair.`);
    }
  }

  const envelope = computeZeroCostEnvelope();
  for (const job of envelope.jobs) {
    lines.push(
      `  ${job.name.padEnd(20)} ${String(job.executions).padStart(6)} executions`
      + ` x ${String(job.billedSecondsPerExecution).padStart(4)} s`
      + ` = ${job.vcpuSeconds.toLocaleString('en-AU').padStart(9)} vCPU-s`
      + ` / ${job.gibSeconds.toLocaleString('en-AU').padStart(9)} GiB-s`,
    );
  }
  lines.push(
    `  TOTAL                       ${envelope.totalVcpuSeconds.toLocaleString('en-AU')} vCPU-s `
    + `(${(envelope.vcpuUtilisation * 100).toFixed(1)}% of grant), `
    + `${envelope.totalGibSeconds.toLocaleString('en-AU')} GiB-s `
    + `(${(envelope.gibUtilisation * 100).toFixed(1)}% of grant)`,
  );
  lines.push(
    `  Dispatcher start-time headroom before the grant is exceeded: `
    + `${envelope.dispatcherStartAllowanceHeadroomSeconds.toFixed(1)} s per execution`,
  );
  if (!envelope.withinGrant) {
    failures.push('Configured worst-case usage exceeds the verified free grant.');
  }
  if (envelope.dispatcherStartAllowanceHeadroomSeconds < 0) {
    failures.push('Dispatcher configuration leaves no allowance for container start time.');
  }
}

function checkLaunchEnvelope(failures: string[], lines: string[]): void {
  const migration = readIfPresent(LAUNCH_ENVELOPE.migrationPath);
  if (migration === null) {
    failures.push(`Execution-control migration is missing: ${LAUNCH_ENVELOPE.migrationPath}`);
    return;
  }

  const required: Array<[string, RegExp]> = [
    ['launch limit equality constraint', new RegExp(`CHECK \\(launch_limit = ${LAUNCH_ENVELOPE.launchLimit}\\)`)],
    ['rolling window equality constraint', new RegExp(`CHECK \\(window_days = ${LAUNCH_ENVELOPE.windowDays}\\)`)],
    ['max active equality constraint', new RegExp(`CHECK \\(max_active_executions = ${LAUNCH_ENVELOPE.maxActiveExecutions}\\)`)],
    ['rolling window budget query', /reserved_at > v_now - pg_catalog\.make_interval\(days => v_guard\.window_days\)/],
    ['irrevocability constraint', /CHECK \(counts_against_budget OR state = 'PRESTART_FAILED'\)/],
  ];
  for (const [label, pattern] of required) {
    if (!pattern.test(migration)) {
      failures.push(`Execution-control migration no longer contains the ${label}.`);
    }
  }

  // Exactly one statement may clear the budget flag, and it must be the pre-transmission branch.
  const refundStatements = migration.match(/counts_against_budget = false/g) ?? [];
  if (refundStatements.length !== 1) {
    failures.push(
      `Execution-control migration releases budget in ${refundStatements.length} places; exactly one `
      + 'pre-transmission branch is permitted.',
    );
  }
  const refundBranch = /IF p_outcome = 'PRESTART_FAILED' THEN[\s\S]{0,600}?counts_against_budget = false[\s\S]{0,400}?AND state = 'RESERVED';/;
  if (!refundBranch.test(migration)) {
    failures.push('Budget release is not restricted to a PRESTART_FAILED outcome on a RESERVED row.');
  }
  for (const state of LAUNCH_ENVELOPE.irrevocableStates) {
    if (new RegExp(`state = '${state}'[\\s\\S]{0,200}counts_against_budget = false`).test(migration)) {
      failures.push(`State ${state} must never release a consumed launch unit.`);
    }
  }

  lines.push(
    `  Hard launch fence: ${LAUNCH_ENVELOPE.launchLimit} starts per rolling `
    + `${LAUNCH_ENVELOPE.windowDays} days, max ${LAUNCH_ENVELOPE.maxActiveExecutions} active, `
    + 'enforced by database constraint.',
  );
  lines.push('  UTC calendar-month counts are reporting only and carry no authority.');
}

function checkNoPaidHostingPath(failures: string[], lines: string[]): void {
  const render = readIfPresent('render.yaml');
  if (render !== null) {
    if (/type:\s*worker/.test(render)) {
      failures.push('render.yaml declares a background worker, which has no free instance type.');
    }
    if (/plan:\s*(?!free\b)\S+/.test(render)) {
      failures.push('render.yaml declares a non-free plan.');
    }
  } else {
    lines.push('  No render.yaml present: the paid background-worker path cannot be deployed.');
  }
}

const FORBIDDEN_BICEP_PATTERNS: Array<[string, RegExp]> = [
  ['a Log Analytics workspace', /Microsoft\.OperationalInsights/],
  ['an Azure Container Registry', /Microsoft\.ContainerRegistry/],
  ['virtual network integration', /vnetConfiguration/],
  ['ingress configuration', /\bingress\s*:/],
  ['a mutable image tag', /image:\s*'[^']*:latest'/],
  ['a NAT gateway', /Microsoft\.Network\/natGateways/],
];

function checkInfrastructureAsCode(failures: string[], lines: string[]): void {
  const bicepPath = 'infra/azure/assistive-executor/main.bicep';
  const bicep = readIfPresent(bicepPath);
  if (bicep === null) {
    failures.push(`Executor infrastructure template is missing: ${bicepPath}`);
    return;
  }
  for (const [label, pattern] of FORBIDDEN_BICEP_PATTERNS) {
    if (pattern.test(bicep)) failures.push(`Executor template introduces ${label}.`);
  }
  const requiredBicep: Array<[string, RegExp]> = [
    ['a Consumption-only workload profile', /workloadProfileType:\s*'Consumption'/],
    ['logs destination none', /destination:\s*'none'/],
    ['a digest-pinned dispatcher image', /dispatcherImageDigest/],
    ['a digest-pinned worker image', /workerImageDigest/],
    ['a schedule bound to the reviewed cadence parameter', /cronExpression:\s*dispatcherCronExpression/],
    ['single-replica job configuration', /parallelism:\s*1/],
  ];
  for (const [label, pattern] of requiredBicep) {
    if (!pattern.test(bicep)) failures.push(`Executor template no longer declares ${label}.`);
  }

  // The cadence is constrained by the template itself, so no deployment can select an unreviewed
  // schedule even though the value is a parameter.
  const allowedBlock = /@allowed\(\[([^\]]*)\]\)\s*param dispatcherCronExpression/.exec(bicep);
  if (!allowedBlock) {
    failures.push('Executor template does not constrain the dispatcher schedule to reviewed values.');
  } else {
    const declared = (allowedBlock[1].match(/'[^']*'/g) ?? []).map((value) => value.slice(1, -1));
    const reviewed = new Set<string>(VERIFIED_DISPATCHER_CRON_EXPRESSIONS);
    if (declared.length === 0 || declared.some((value) => !reviewed.has(value))) {
      failures.push(
        `Executor template permits an unreviewed dispatcher schedule: [${declared.join(', ')}].`,
      );
    }
  }
  // Resource type strings carry an @api-version; only the bare provider operations are permissions.
  const roleActions = (bicep.match(/'Microsoft\.App\/[^'@]+'/g) ?? [])
    .filter((value) => value.includes('/jobs/'));
  const permitted = new Set(["'Microsoft.App/jobs/read'", "'Microsoft.App/jobs/start/action'"]);
  if (roleActions.length === 0) {
    failures.push('Executor template no longer declares an explicit least-privilege job role.');
  }
  for (const action of roleActions) {
    if (!permitted.has(action)) {
      failures.push(`Executor template grants a wider cloud permission than required: ${action}.`);
    }
  }
  lines.push(`  Executor template verified: ${bicepPath}`);
}

export function checkZeroCostEnvelope(): EnvelopeCheckResult {
  const failures: string[] = [];
  const lines: string[] = [];
  lines.push('Compute envelope (worst-case 31-day month):');
  checkComputeEnvelope(failures, lines);
  lines.push('Launch envelope:');
  checkLaunchEnvelope(failures, lines);
  lines.push('Hosting paths:');
  checkNoPaidHostingPath(failures, lines);
  checkInfrastructureAsCode(failures, lines);
  return { failures, lines };
}

if (typeof require !== 'undefined' && require.main === module) {
  const { failures, lines } = checkZeroCostEnvelope();
  console.log('=== Zero-cost execution envelope ===');
  lines.forEach((line) => console.log(line));
  console.log(`\n${SUBSCRIPTION_SCOPE_CAVEAT}`);
  if (failures.length > 0) {
    console.error('\nZero-cost envelope check failed:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('\nZero-cost envelope check passed.');
  }
}
