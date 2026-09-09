import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const INCIDENT_LEDGER = Object.freeze({
  label: 'zero-cost-staging-monitoring',
  title: '[staging-monitor] Public staging endpoint failure',
  marker: '<!-- zero-cost-staging-monitoring:incident:v1 -->',
  maxAttempts: 5,
  recoveryConfirmationsRequired: 3,
  issuePageSize: 100,
  maxIssuePages: 10,
  labelColor: 'B60205',
  labelDescription: 'Repository-owned zero-cost staging monitor incident',
});

const SAFE_CODES = new Set([
  'HTTP_200',
  'UNEXPECTED_REDIRECT',
  'UNEXPECTED_RESPONSE',
  'UNEXPECTED_STATUS',
  'TIMEOUT',
  'TRANSPORT_FAILURE',
]);

const MONITORED_ENDPOINTS = Object.freeze([
  '/api/health',
  '/api/readiness',
]);

const execFileAsync = promisify(execFile);

export class IncidentLedgerError extends Error {
  constructor(code) {
    super('Unable to synchronize the staging monitoring incident ledger.');
    this.name = 'IncidentLedgerError';
    this.code = code;
  }
}

function invalidInput() {
  return new IncidentLedgerError('INVALID_INPUT');
}

function safeFactValue(value) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) {
    return String(value);
  }

  if (typeof value === 'string') {
    if (/^[1-5][0-9]{2}$/.test(value)) {
      return value;
    }
    if (SAFE_CODES.has(value)) {
      return value;
    }
  }

  return 'UNAVAILABLE';
}

export function sanitizeMonitorFacts(input = {}) {
  const { attemptCount, endpointFacts } = input ?? {};
  const safeAttemptCount = Number.isInteger(attemptCount)
    && attemptCount >= 1
    && attemptCount <= INCIDENT_LEDGER.maxAttempts
    ? `${attemptCount}/${INCIDENT_LEDGER.maxAttempts}`
    : 'UNAVAILABLE';

  const safeEndpointFacts = MONITORED_ENDPOINTS
    .map((endpoint) => `${endpoint}=${safeFactValue(endpointFacts?.[endpoint])}`)
    .join('; ');

  return Object.freeze({
    attempts: safeAttemptCount,
    endpointFacts: safeEndpointFacts,
  });
}

export function parseMonitorOutput(output) {
  if (typeof output !== 'string') {
    return null;
  }

  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('STAGING_MONITOR '));
  const match = line?.match(
    /^STAGING_MONITOR outcome=(PASS|FAIL) attempts=([0-9]+)\/([0-9]+) endpoints=(.+)$/,
  );

  if (!match || Number(match[3]) !== INCIDENT_LEDGER.maxAttempts) {
    return null;
  }

  const attemptCount = Number(match[2]);
  if (!Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount > INCIDENT_LEDGER.maxAttempts) {
    return null;
  }

  const endpointFacts = {};
  for (const pair of match[4].split(',')) {
    const parts = pair.split('=');
    if (parts.length !== 2 || !MONITORED_ENDPOINTS.includes(parts[0]) || endpointFacts[parts[0]]) {
      return null;
    }

    const value = parts[1];
    if (safeFactValue(value) === 'UNAVAILABLE') {
      return null;
    }
    endpointFacts[parts[0]] = value;
  }

  if (Object.keys(endpointFacts).length !== MONITORED_ENDPOINTS.length) {
    return null;
  }

  if (match[1] === 'PASS' && MONITORED_ENDPOINTS.some((endpoint) => endpointFacts[endpoint] !== '200')) {
    return null;
  }

  return Object.freeze({
    outcome: match[1],
    attemptCount,
    endpointFacts: Object.freeze(endpointFacts),
  });
}

export function determineLedgerOutcome({ stepOutcome, monitorSummary } = {}) {
  const fullPass = monitorSummary?.outcome === 'PASS'
    && Number.isInteger(monitorSummary.attemptCount)
    && monitorSummary.attemptCount >= 1
    && monitorSummary.attemptCount <= INCIDENT_LEDGER.maxAttempts
    && monitorSummary.endpointFacts
    && typeof monitorSummary.endpointFacts === 'object'
    && Object.keys(monitorSummary.endpointFacts).length === MONITORED_ENDPOINTS.length
    && MONITORED_ENDPOINTS.every((endpoint) => monitorSummary.endpointFacts[endpoint] === '200');
  return stepOutcome === 'success' && fullPass ? 'PASS' : 'FAIL';
}

export function determineWorkflowExitCode({
  monitorStepOutcome,
  ledgerStepOutcome,
  monitorSummary,
} = {}) {
  const derivedMonitorOutcome = determineLedgerOutcome({
    stepOutcome: monitorStepOutcome,
    monitorSummary,
  });
  return derivedMonitorOutcome === 'PASS' && ledgerStepOutcome === 'success' ? 0 : 1;
}

export function buildIncidentBody({
  state,
  outcome,
  monitorFacts,
  recoveryConfirmations = state === 'RECOVERED'
    ? INCIDENT_LEDGER.recoveryConfirmationsRequired
    : 0,
} = {}) {
  if (!['OPEN', 'RECOVERED'].includes(state) || !['FAIL', 'PASS'].includes(outcome)) {
    throw invalidInput();
  }
  if (
    !Number.isInteger(recoveryConfirmations)
    || recoveryConfirmations < 0
    || recoveryConfirmations > INCIDENT_LEDGER.recoveryConfirmationsRequired
  ) {
    throw invalidInput();
  }

  const facts = sanitizeMonitorFacts(monitorFacts);
  return [
    INCIDENT_LEDGER.marker,
    'Repository-owned zero-cost staging monitor incident record.',
    `State: ${state}`,
    `Outcome: ${outcome}`,
    `Recovery confirmations: ${recoveryConfirmations}/${INCIDENT_LEDGER.recoveryConfirmationsRequired}`,
    `Attempts: ${facts.attempts}`,
    `Endpoint facts: ${facts.endpointFacts}`,
  ].join('\n');
}

export function parseRecoveryConfirmations(body) {
  if (typeof body !== 'string') {
    return null;
  }

  const line = body
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('Recovery confirmations:'));
  if (line === undefined) {
    return 0;
  }

  const match = line.match(
    new RegExp(`^Recovery confirmations: ([0-${INCIDENT_LEDGER.recoveryConfirmationsRequired}])/${INCIDENT_LEDGER.recoveryConfirmationsRequired}$`),
  );
  return match ? Number(match[1]) : null;
}

function issueLabelNames(issue) {
  if (!Array.isArray(issue?.labels)) {
    return [];
  }

  return issue.labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string');
}

function selectOwnedIncident(issues) {
  if (!Array.isArray(issues)) {
    throw new IncidentLedgerError('API_FAILURE');
  }

  const labeledTitleMatches = issues.filter((issue) => (
    issue
    && !issue.pull_request
    && issue.title === INCIDENT_LEDGER.title
    && issueLabelNames(issue).includes(INCIDENT_LEDGER.label)
  ));

  if (labeledTitleMatches.length > 1) {
    throw new IncidentLedgerError('AMBIGUOUS_INCIDENT');
  }

  const candidate = labeledTitleMatches[0];
  if (!candidate) {
    return null;
  }

  if (
    !Number.isInteger(candidate.number)
    || candidate.number < 1
    || typeof candidate.body !== 'string'
    || !candidate.body.split(/\r?\n/).includes(INCIDENT_LEDGER.marker)
    || !['open', 'closed'].includes(candidate.state)
  ) {
    throw new IncidentLedgerError('IDENTITY_COLLISION');
  }

  return Object.freeze({
    number: candidate.number,
    state: candidate.state,
    body: candidate.body,
  });
}

async function callApi(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IncidentLedgerError) {
      throw error;
    }
    throw new IncidentLedgerError('API_FAILURE');
  }
}

function validateApi(api) {
  if (
    !api
    || typeof api.listIssues !== 'function'
    || typeof api.ensureLabel !== 'function'
    || typeof api.createIssue !== 'function'
    || typeof api.updateIssue !== 'function'
  ) {
    throw invalidInput();
  }
}

export async function syncIncident({ outcome, monitorFacts, api } = {}) {
  if (!['PASS', 'FAIL'].includes(outcome)) {
    throw invalidInput();
  }
  validateApi(api);

  const issues = await callApi(() => api.listIssues());
  const incident = selectOwnedIncident(issues);

  if (outcome === 'PASS') {
    if (!incident || incident.state === 'closed') {
      return Object.freeze({
        action: 'NOOP',
        state: incident ? 'CLOSED' : 'NONE',
      });
    }

    const currentConfirmations = parseRecoveryConfirmations(incident.body);
    if (
      currentConfirmations === null
      || currentConfirmations >= INCIDENT_LEDGER.recoveryConfirmationsRequired
    ) {
      throw new IncidentLedgerError('IDENTITY_COLLISION');
    }

    const nextConfirmations = currentConfirmations + 1;
    if (nextConfirmations < INCIDENT_LEDGER.recoveryConfirmationsRequired) {
      await callApi(() => api.updateIssue(incident.number, {
        state: 'open',
        body: buildIncidentBody({
          state: 'OPEN',
          outcome: 'PASS',
          monitorFacts,
          recoveryConfirmations: nextConfirmations,
        }),
      }));

      return Object.freeze({
        action: 'RECOVERY_PENDING',
        state: 'OPEN',
        confirmations: nextConfirmations,
      });
    }

    await callApi(() => api.updateIssue(incident.number, {
      state: 'closed',
      body: buildIncidentBody({
        state: 'RECOVERED',
        outcome: 'PASS',
        monitorFacts,
        recoveryConfirmations: INCIDENT_LEDGER.recoveryConfirmationsRequired,
      }),
    }));

    return Object.freeze({ action: 'RECOVERED', state: 'CLOSED' });
  }

  const body = buildIncidentBody({ state: 'OPEN', outcome: 'FAIL', monitorFacts });
  if (incident) {
    if (incident.state === 'open' && incident.body === body) {
      return Object.freeze({ action: 'UNCHANGED', state: 'OPEN' });
    }

    await callApi(() => api.updateIssue(incident.number, {
      state: 'open',
      body,
    }));

    return Object.freeze({
      action: incident.state === 'closed' ? 'REOPENED' : 'UPDATED',
      state: 'OPEN',
    });
  }

  await callApi(() => api.ensureLabel());
  const created = await callApi(() => api.createIssue({
    title: INCIDENT_LEDGER.title,
    body,
    labels: [INCIDENT_LEDGER.label],
  }));

  if (!Number.isInteger(created?.number) || created.number < 1) {
    throw new IncidentLedgerError('API_FAILURE');
  }

  return Object.freeze({ action: 'CREATED', state: 'OPEN' });
}

function validateRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw invalidInput();
  }
  return value;
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new IncidentLedgerError('API_FAILURE');
  }
}

function flattenPaginatedPayload(payload, property) {
  const pages = Array.isArray(payload) ? payload : [payload];
  const records = [];
  for (const page of pages) {
    if (Array.isArray(page)) {
      records.push(...page);
    } else if (Array.isArray(page?.[property])) {
      records.push(...page[property]);
    } else {
      throw new IncidentLedgerError('API_FAILURE');
    }
  }
  return records;
}

export function parseIssueListPayload(payload) {
  if (!Array.isArray(payload)) {
    throw new IncidentLedgerError('API_FAILURE');
  }
  return payload;
}

export async function listPaginatedIssues(
  fetchPage,
  { maxPages = INCIDENT_LEDGER.maxIssuePages } = {},
) {
  if (
    typeof fetchPage !== 'function'
    || !Number.isInteger(maxPages)
    || maxPages < 1
  ) {
    throw invalidInput();
  }

  const issues = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageIssues = parseIssueListPayload(await fetchPage(page));
    issues.push(...pageIssues);
    if (pageIssues.length < INCIDENT_LEDGER.issuePageSize) {
      return issues;
    }
  }

  throw new IncidentLedgerError('PAGINATION_TRUNCATED');
}

async function runGhApi(args) {
  try {
    const result = await execFileAsync('gh', ['api', ...args], {
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch {
    throw new IncidentLedgerError('API_FAILURE');
  }
}

export function createGhApi({ repository } = {}) {
  const repo = validateRepository(repository);

  return Object.freeze({
    async listIssues() {
      return listPaginatedIssues(async (page) => {
        const output = await runGhApi([
          '--method',
          'GET',
          `repos/${repo}/issues?state=all&labels=${encodeURIComponent(INCIDENT_LEDGER.label)}&per_page=${INCIDENT_LEDGER.issuePageSize}&page=${page}`,
        ]);
        return parseIssueListPayload(parseJson(output));
      });
    },

    async ensureLabel() {
      const output = await runGhApi([
        '--method',
        'GET',
        `repos/${repo}/labels?per_page=100`,
        '--paginate',
        '--slurp',
      ]);
      const labels = flattenPaginatedPayload(parseJson(output), 'items');
      if (labels.some((label) => label?.name === INCIDENT_LEDGER.label)) {
        return;
      }

      await runGhApi([
        '--method',
        'POST',
        `repos/${repo}/labels`,
        '-f',
        `name=${INCIDENT_LEDGER.label}`,
        '-f',
        `color=${INCIDENT_LEDGER.labelColor}`,
        '-f',
        `description=${INCIDENT_LEDGER.labelDescription}`,
      ]);
    },

    async createIssue({ title, body, labels }) {
      const output = await runGhApi([
        '--method',
        'POST',
        `repos/${repo}/issues`,
        '-f',
        `title=${title}`,
        '-f',
        `body=${body}`,
        '-f',
        `labels[]=${labels[0]}`,
      ]);
      return parseJson(output);
    },

    async updateIssue(number, { state, body }) {
      const output = await runGhApi([
        '--method',
        'PATCH',
        `repos/${repo}/issues/${number}`,
        '-f',
        `state=${state}`,
        '-f',
        `body=${body}`,
      ]);
      return parseJson(output);
    },
  });
}

async function readMonitorSummary(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }

  try {
    return parseMonitorOutput(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function main(env = process.env) {
  try {
    const monitorSummary = await readMonitorSummary(env.MONITOR_RESULT_FILE);
    const outcome = determineLedgerOutcome({
      stepOutcome: env.MONITOR_STEP_OUTCOME,
      monitorSummary,
    });
    const result = await syncIncident({
      outcome,
      monitorFacts: monitorSummary,
      api: createGhApi({ repository: env.GITHUB_REPOSITORY }),
    });
    console.log(`INCIDENT_LEDGER result=PASS state=${result.state} action=${result.action}`);
    return 0;
  } catch (error) {
    const code = error instanceof IncidentLedgerError
      && ['API_FAILURE', 'AMBIGUOUS_INCIDENT', 'IDENTITY_COLLISION', 'INVALID_INPUT'].includes(error.code)
      ? error.code
      : 'API_FAILURE';
    console.error(`INCIDENT_LEDGER outcome=FAIL code=${code}`);
    return 1;
  }
}

export async function enforceWorkflowResult(env = process.env) {
  const monitorSummary = await readMonitorSummary(env.MONITOR_RESULT_FILE);
  const exitCode = determineWorkflowExitCode({
    monitorStepOutcome: env.MONITOR_STEP_OUTCOME,
    ledgerStepOutcome: env.INCIDENT_LEDGER_STEP_OUTCOME,
    monitorSummary,
  });
  console[exitCode === 0 ? 'log' : 'error'](
    `STAGING_MONITOR_WORKFLOW result=${exitCode === 0 ? 'PASS' : 'FAIL'}`,
  );
  return exitCode;
}

export async function cli(args = process.argv.slice(2), env = process.env) {
  if (args.length === 0) {
    return main(env);
  }
  if (args.length === 1 && args[0] === '--enforce-workflow-result') {
    return enforceWorkflowResult(env);
  }
  console.error('INCIDENT_LEDGER outcome=FAIL code=INVALID_INPUT');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await cli();
}
