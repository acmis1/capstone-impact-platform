import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  INCIDENT_LEDGER,
  IncidentLedgerError,
  buildIncidentBody,
  determineLedgerOutcome,
  determineWorkflowExitCode,
  listPaginatedIssues,
  parseIssueListPayload,
  parseMonitorOutput,
  parseRecoveryConfirmations,
  sanitizeMonitorFacts,
  syncIncident,
} from './incident-ledger.mjs';

const healthyFacts = {
  attemptCount: 2,
  endpointFacts: {
    '/api/health': 200,
    '/api/readiness': 200,
  },
};

const failureFacts = {
  attemptCount: 5,
  endpointFacts: {
    '/api/health': 503,
    '/api/readiness': 'TIMEOUT',
  },
};

function ownedIssue({ number = 7, state = 'open', body = buildIncidentBody({
  state: state === 'open' ? 'OPEN' : 'RECOVERED',
  outcome: state === 'open' ? 'FAIL' : 'PASS',
  monitorFacts: state === 'open' ? failureFacts : healthyFacts,
}) } = {}) {
  return {
    number,
    state,
    title: INCIDENT_LEDGER.title,
    body,
    labels: [{ name: INCIDENT_LEDGER.label }],
  };
}

function fakeApi({ issues = [], createdNumber = 99, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      async listIssues() {
        calls.push({ method: 'listIssues' });
        if (fail.listIssues) throw new Error('private API detail');
        return issues;
      },
      async ensureLabel() {
        calls.push({ method: 'ensureLabel' });
        if (fail.ensureLabel) throw new Error('private label detail');
      },
      async createIssue(payload) {
        calls.push({ method: 'createIssue', payload });
        if (fail.createIssue) throw new Error('private create detail');
        return { number: createdNumber };
      },
      async updateIssue(number, payload) {
        calls.push({ method: 'updateIssue', number, payload });
        if (fail.updateIssue) throw new Error('private update detail');
        return { number };
      },
    },
  };
}

test('first sustained failure creates a fixed-identity open incident', async () => {
  const { api, calls } = fakeApi();

  const result = await syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api });

  assert.deepEqual(result, { action: 'CREATED', state: 'OPEN' });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues', 'ensureLabel', 'createIssue']);
  assert.deepEqual(calls.at(-1).payload.labels, [INCIDENT_LEDGER.label]);
  assert.equal(calls.at(-1).payload.title, INCIDENT_LEDGER.title);
  assert.equal(calls.at(-1).payload.body, buildIncidentBody({
    state: 'OPEN',
    outcome: 'FAIL',
    monitorFacts: failureFacts,
  }));
});

test('repeat failure reuses the owned incident in a sequential run', async () => {
  const incident = ownedIssue();
  const { api, calls } = fakeApi({ issues: [incident] });

  const result = await syncIncident({
    outcome: 'FAIL',
    monitorFacts: {
      attemptCount: 5,
      endpointFacts: { '/api/health': 502, '/api/readiness': 'TRANSPORT_FAILURE' },
    },
    api,
  });

  assert.deepEqual(result, { action: 'UPDATED', state: 'OPEN' });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues', 'updateIssue']);
  assert.equal(calls[1].number, incident.number);
  assert.equal(calls[1].payload.state, 'open');
  assert.equal(calls[1].payload.body.includes('502'), true);
});

test('duplicate matching issues fail closed as ambiguous without mutation', async () => {
  const { api, calls } = fakeApi({ issues: [ownedIssue({ number: 1 }), ownedIssue({ number: 2 })] });

  await assert.rejects(
    syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api }),
    (error) => error instanceof IncidentLedgerError && error.code === 'AMBIGUOUS_INCIDENT',
  );
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues']);
});

test('an unlabelled public title collision is ignored', async () => {
  const unowned = { ...ownedIssue({ number: 3 }), labels: [], body: 'untrusted issue text' };
  const { api, calls } = fakeApi({ issues: [unowned] });

  const result = await syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api });

  assert.deepEqual(result, { action: 'CREATED', state: 'OPEN' });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues', 'ensureLabel', 'createIssue']);
});

test('a labelled fixed-title issue with a different marker fails closed', async () => {
  const unowned = { ...ownedIssue({ number: 3 }), body: '<!-- another-workflow:incident:v1 -->' };
  const { api, calls } = fakeApi({ issues: [unowned] });

  await assert.rejects(
    syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api }),
    (error) => error instanceof IncidentLedgerError && error.code === 'IDENTITY_COLLISION',
  );
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues']);
});

test('the first full PASS records one pending recovery confirmation', async () => {
  const incident = ownedIssue();
  const { api, calls } = fakeApi({ issues: [incident] });

  const result = await syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api });

  assert.deepEqual(result, { action: 'RECOVERY_PENDING', state: 'OPEN', confirmations: 1 });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues', 'updateIssue']);
  assert.equal(calls[1].number, incident.number);
  assert.equal(calls[1].payload.state, 'open');
  assert.equal(calls[1].payload.body.includes('Recovery confirmations: 1/3'), true);
  assert.equal(calls[1].payload.body.includes('Outcome: PASS'), true);
});

test('the second consecutive full PASS remains open with two confirmations', async () => {
  const incident = ownedIssue({
    body: buildIncidentBody({
      state: 'OPEN',
      outcome: 'PASS',
      monitorFacts: healthyFacts,
      recoveryConfirmations: 1,
    }),
  });
  const { api, calls } = fakeApi({ issues: [incident] });

  const result = await syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api });

  assert.deepEqual(result, { action: 'RECOVERY_PENDING', state: 'OPEN', confirmations: 2 });
  assert.equal(calls[1].payload.state, 'open');
  assert.equal(calls[1].payload.body.includes('Recovery confirmations: 2/3'), true);
});

test('the third consecutive full PASS closes the owned incident as recovered', async () => {
  const incident = ownedIssue({
    body: buildIncidentBody({
      state: 'OPEN',
      outcome: 'PASS',
      monitorFacts: healthyFacts,
      recoveryConfirmations: 2,
    }),
  });
  const { api, calls } = fakeApi({ issues: [incident] });

  const result = await syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api });

  assert.deepEqual(result, { action: 'RECOVERED', state: 'CLOSED' });
  assert.equal(calls[1].payload.state, 'closed');
  assert.equal(calls[1].payload.body.includes('State: RECOVERED'), true);
  assert.equal(calls[1].payload.body.includes('Recovery confirmations: 3/3'), true);
  assert.equal(parseRecoveryConfirmations(calls[1].payload.body), 3);
});

test('a failure resets pending recovery before future confirmations', async () => {
  const incident = ownedIssue({
    body: buildIncidentBody({
      state: 'OPEN',
      outcome: 'PASS',
      monitorFacts: healthyFacts,
      recoveryConfirmations: 2,
    }),
  });
  const firstRun = fakeApi({ issues: [incident] });

  const failureResult = await syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api: firstRun.api });

  assert.deepEqual(failureResult, { action: 'UPDATED', state: 'OPEN' });
  assert.equal(firstRun.calls[1].payload.body.includes('Recovery confirmations: 0/3'), true);

  const resetIncident = {
    ...incident,
    body: firstRun.calls[1].payload.body,
  };
  const secondRun = fakeApi({ issues: [resetIncident] });
  const passResult = await syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api: secondRun.api });

  assert.deepEqual(passResult, { action: 'RECOVERY_PENDING', state: 'OPEN', confirmations: 1 });
  assert.equal(secondRun.calls[1].payload.body.includes('Recovery confirmations: 1/3'), true);
});

test('a later failure reopens the same recovered incident instead of creating another', async () => {
  const incident = ownedIssue({ state: 'closed' });
  const { api, calls } = fakeApi({ issues: [incident] });

  const result = await syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api });

  assert.deepEqual(result, { action: 'REOPENED', state: 'OPEN' });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues', 'updateIssue']);
  assert.equal(calls[1].number, incident.number);
  assert.equal(calls[1].payload.state, 'open');
});

test('PASS with no incident does nothing', async () => {
  const { api, calls } = fakeApi();

  const result = await syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api });

  assert.deepEqual(result, { action: 'NOOP', state: 'NONE' });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues']);
});

test('API failure is generic, non-success, and never exposes provider details', async () => {
  const { api, calls } = fakeApi({ fail: { listIssues: true } });

  await assert.rejects(
    syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api }),
    (error) => error instanceof IncidentLedgerError
      && error.code === 'API_FAILURE'
      && !error.message.includes('private API detail'),
  );
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues']);
});

test('issue listing follows pages beyond the page size and stops at a short page', async () => {
  const calls = [];
  const pages = [
    Array.from({ length: INCIDENT_LEDGER.issuePageSize }, (_, index) => ({ number: index + 1 })),
    [ownedIssue()],
  ];

  const issues = await listPaginatedIssues(async (page) => {
    calls.push(page);
    return pages[page - 1];
  });

  assert.equal(issues.length, INCIDENT_LEDGER.issuePageSize + 1);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(parseIssueListPayload(pages[1]), pages[1]);
});

test('issue listing fails closed when bounded pagination is truncated', async () => {
  const calls = [];
  const fullPage = Array.from({ length: INCIDENT_LEDGER.issuePageSize }, (_, index) => ({ number: index + 1 }));

  await assert.rejects(
    listPaginatedIssues(async (page) => {
      calls.push(page);
      return fullPage;
    }, { maxPages: 2 }),
    (error) => error instanceof IncidentLedgerError && error.code === 'PAGINATION_TRUNCATED',
  );
  assert.deepEqual(calls, [1, 2]);
});

test('duplicate owned issues remain ambiguous across paginated pages', async () => {
  const firstPage = Array.from(
    { length: INCIDENT_LEDGER.issuePageSize },
    (_, index) => index === 0 ? ownedIssue({ number: 1 }) : { number: index + 10 },
  );
  const secondPage = [ownedIssue({ number: 2 })];
  const { api, calls } = fakeApi({
    issues: [],
  });
  api.listIssues = async () => listPaginatedIssues(async (page) => [firstPage, secondPage][page - 1]);

  await assert.rejects(
    syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api }),
    (error) => error instanceof IncidentLedgerError && error.code === 'AMBIGUOUS_INCIDENT',
  );
  assert.deepEqual(calls, []);
});

test('recovery API failure does not return a recovery result', async () => {
  const incident = ownedIssue();
  const { api, calls } = fakeApi({ issues: [incident], fail: { updateIssue: true } });

  await assert.rejects(
    syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api }),
    (error) => error instanceof IncidentLedgerError && error.code === 'API_FAILURE',
  );
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues', 'updateIssue']);
});

test('sanitized output contains only bounded allowlisted facts', () => {
  const facts = sanitizeMonitorFacts({
    attemptCount: 999,
    endpointFacts: {
      '/api/health': '503\n<!-- injected -->',
      '/api/readiness': 'https://private.example/?token=secret',
    },
  });
  const body = buildIncidentBody({ state: 'OPEN', outcome: 'FAIL', monitorFacts: facts });

  assert.equal(facts.attempts, 'UNAVAILABLE');
  assert.equal(body.includes('injected'), false);
  assert.equal(body.includes('private.example'), false);
  assert.equal(body.includes('secret'), false);
  assert.match(body, /\/api\/health=UNAVAILABLE/);
  assert.match(body, /\/api\/readiness=UNAVAILABLE/);
});

test('identical repeated failure is idempotent and skips the issue update', async () => {
  const body = buildIncidentBody({ state: 'OPEN', outcome: 'FAIL', monitorFacts: failureFacts });
  const { api, calls } = fakeApi({ issues: [ownedIssue({ body })] });

  const result = await syncIncident({ outcome: 'FAIL', monitorFacts: failureFacts, api });

  assert.deepEqual(result, { action: 'UNCHANGED', state: 'OPEN' });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues']);
});

test('closed owned incident is not closed again and workflow/API failure cannot claim recovery', async () => {
  const { api, calls } = fakeApi({ issues: [ownedIssue({ state: 'closed' })] });
  const result = await syncIncident({ outcome: 'PASS', monitorFacts: healthyFacts, api });

  assert.deepEqual(result, { action: 'NOOP', state: 'CLOSED' });
  assert.deepEqual(calls.map(({ method }) => method), ['listIssues']);
  assert.equal(determineLedgerOutcome({
    stepOutcome: 'failure',
    monitorSummary: { outcome: 'PASS' },
  }), 'FAIL');
  assert.equal(determineLedgerOutcome({
    stepOutcome: 'success',
    monitorSummary: null,
  }), 'FAIL');
});

test('valid monitor output is parsed only when both endpoints and bounded facts are exact', () => {
  const summary = parseMonitorOutput(
    'STAGING_MONITOR outcome=PASS attempts=3/5 endpoints=/api/health=200,/api/readiness=200',
  );

  assert.deepEqual(summary, {
    outcome: 'PASS',
    attemptCount: 3,
    endpointFacts: { '/api/health': '200', '/api/readiness': '200' },
  });
  assert.equal(parseMonitorOutput(
    'STAGING_MONITOR outcome=PASS attempts=3/5 endpoints=/api/health=200,/api/readiness=https://private/?token=x',
  ), null);
  assert.equal(parseMonitorOutput(
    'STAGING_MONITOR outcome=PASS attempts=3/5 endpoints=/api/health=200,/api/readiness=TIMEOUT',
  ), null);
});

test('probe success with malformed summary stays red even when ledger update succeeds', async () => {
  const { api, calls } = fakeApi();
  const ledgerResult = await syncIncident({ outcome: 'FAIL', monitorFacts: null, api });

  assert.deepEqual(ledgerResult, { action: 'CREATED', state: 'OPEN' });
  assert.equal(calls.at(-1).method, 'createIssue');
  assert.equal(determineWorkflowExitCode({
    monitorStepOutcome: 'success',
    ledgerStepOutcome: 'success',
    monitorSummary: null,
  }), 1);
});

test('workflow result is green only when step outcomes and a full PASS summary succeed', () => {
  const validSummary = {
    outcome: 'PASS',
    attemptCount: 2,
    endpointFacts: { '/api/health': '200', '/api/readiness': '200' },
  };
  assert.equal(determineWorkflowExitCode({
    monitorStepOutcome: 'success',
    ledgerStepOutcome: 'success',
    monitorSummary: validSummary,
  }), 0);
  for (const [monitorStepOutcome, ledgerStepOutcome] of [
    ['failure', 'success'],
    ['success', 'failure'],
    ['failure', 'failure'],
    ['success', 'skipped'],
  ]) {
    assert.equal(determineWorkflowExitCode({
      monitorStepOutcome,
      ledgerStepOutcome,
      monitorSummary: validSummary,
    }), 1);
  }
  assert.equal(determineWorkflowExitCode({
    monitorStepOutcome: 'success',
    ledgerStepOutcome: 'success',
    monitorSummary: {
      outcome: 'PASS',
      attemptCount: 2,
      endpointFacts: { '/api/health': '200' },
    },
  }), 1);
});

test('workflow statically runs ledger after probe and enforces both step outcomes', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/zero-cost-staging-monitoring.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /id: probe\r?\n\s+continue-on-error: true/);
  assert.match(workflow, /name: Sync repository-owned incident ledger\r?\n\s+id: incident_ledger/);
  assert.match(
    workflow,
    /name: Enforce probe and ledger result\r?\n\s+if: \$\{\{ always\(\) && steps\.probe\.outcome != 'skipped' \}\}/,
  );
  assert.match(workflow, /MONITOR_STEP_OUTCOME: \$\{\{ steps\.probe\.outcome \}\}/);
  assert.match(
    workflow,
    /INCIDENT_LEDGER_STEP_OUTCOME: \$\{\{ steps\.incident_ledger\.outcome \}\}/,
  );
  assert.match(workflow, /MONITOR_RESULT_FILE: \$\{\{ runner\.temp \}\}\/zero-cost-staging-monitoring\.log/);
  assert.match(workflow, /--enforce-workflow-result/);
  assert.ok(workflow.indexOf('id: probe') < workflow.indexOf('id: incident_ledger'));
  assert.ok(
    workflow.indexOf('id: incident_ledger') < workflow.indexOf('name: Enforce probe and ledger result'),
  );
});

test('workflow statically preserves the exact cadence, permissions, origin, and triggers', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/zero-cost-staging-monitoring.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /^\s+- cron: '17 \*\/6 \* \* \*'\s*$/m);
  assert.match(workflow, /^permissions:\r?\n  contents: read\r?\n/m);
  assert.match(
    workflow,
    /  probe:[\s\S]*?    permissions:\r?\n      contents: read\r?\n      issues: write\r?\n/,
  );
  assert.doesNotMatch(workflow, /^  issues: write$/m);
  assert.match(workflow, /https:\/\/capstone-admin-cms-staging-v2\.onrender\.com/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request):/m);
});

test('ledger statically uses bounded label-filtered Issues API discovery, not Search API', () => {
  const ledger = readFileSync(new URL('./incident-ledger.mjs', import.meta.url), 'utf8');

  assert.match(ledger, /repos\/\$\{repo\}\/issues\?state=all&labels=/);
  assert.match(ledger, /per_page=\$\{INCIDENT_LEDGER\.issuePageSize\}&page=\$\{page\}/);
  assert.doesNotMatch(ledger, /search\/issues/);
});
