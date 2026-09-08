import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MONITORED_ENDPOINTS,
  MONITOR_LIMITS,
  MonitoringInputError,
  runMonitor,
  validateBaseUrl,
} from './monitor.mjs';

const BASE_URL = 'https://monitor.example.test';

function response(status, { redirected = false, secretBody = '' } = {}) {
  let bodyUsed = false;
  return {
    status,
    redirected,
    get bodyUsed() {
      return bodyUsed;
    },
    async text() {
      bodyUsed = true;
      return secretBody;
    },
  };
}

function queuedFetch(queue) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('test fixture exhausted');
    return next;
  };
  return { calls, fetchImpl };
}

const noSleep = async () => {};

test('returns success for an immediate healthy result', async () => {
  const { calls, fetchImpl } = queuedFetch([response(200), response(200)]);

  const report = await runMonitor({ baseUrl: BASE_URL, fetchImpl, sleepImpl: noSleep });

  assert.equal(report.outcome, 'PASS');
  assert.equal(report.attempts.length, 1);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), MONITORED_ENDPOINTS);
  for (const call of calls) {
    assert.equal(call.init.method, 'HEAD');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers, undefined);
  }
});

test('retries a transient readiness failure until both endpoints converge', async () => {
  const { calls, fetchImpl } = queuedFetch([
    response(200),
    response(503),
    response(200),
    response(200),
  ]);

  const report = await runMonitor({ baseUrl: BASE_URL, fetchImpl, sleepImpl: noSleep });

  assert.equal(report.outcome, 'PASS');
  assert.equal(report.attempts.length, 2);
  assert.equal(calls.length, 4);
  assert.equal(report.attempts[0].results[1].code, 'UNEXPECTED_STATUS');
});

test('fails after bounded retries for sustained 503 responses', async () => {
  const { calls, fetchImpl } = queuedFetch(
    Array.from({ length: MONITOR_LIMITS.maxAttempts * MONITORED_ENDPOINTS.length }, () => response(503)),
  );

  const report = await runMonitor({ baseUrl: BASE_URL, fetchImpl, sleepImpl: noSleep });

  assert.equal(report.outcome, 'FAIL');
  assert.equal(report.attempts.length, MONITOR_LIMITS.maxAttempts);
  assert.equal(calls.length, MONITOR_LIMITS.maxAttempts * MONITORED_ENDPOINTS.length);
});

test('fails closed for sustained 5xx responses', async () => {
  const { fetchImpl } = queuedFetch(
    Array.from({ length: MONITOR_LIMITS.maxAttempts * MONITORED_ENDPOINTS.length }, (_, index) => (
      response(index % 2 === 0 ? 500 : 502)
    )),
  );

  const report = await runMonitor({ baseUrl: BASE_URL, fetchImpl, sleepImpl: noSleep });

  assert.equal(report.outcome, 'FAIL');
  assert.equal(report.attempts.at(-1).results[0].status, 500);
  assert.equal(report.attempts.at(-1).results[1].status, 502);
});

test('fails closed for transport failures', async () => {
  const { fetchImpl } = queuedFetch([
    new Error('private transport detail'),
    response(200),
  ]);

  const report = await runMonitor({
    baseUrl: BASE_URL,
    fetchImpl,
    maxAttempts: 1,
    sleepImpl: noSleep,
  });

  assert.equal(report.outcome, 'FAIL');
  assert.equal(report.attempts[0].results[0].code, 'TRANSPORT_FAILURE');
  assert.equal(JSON.stringify(report).includes('private transport detail'), false);
});

test('classifies a bounded request timeout without exposing the transport error', async () => {
  const fetchImpl = async (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('private timeout detail')), {
      once: true,
    });
  });

  const report = await runMonitor({
    baseUrl: BASE_URL,
    fetchImpl,
    maxAttempts: 1,
    requestTimeoutMs: 5,
    sleepImpl: noSleep,
  });

  assert.equal(report.outcome, 'FAIL');
  assert.equal(report.attempts[0].results[0].code, 'TIMEOUT');
  assert.equal(JSON.stringify(report).includes('private timeout detail'), false);
});

test('rejects an unexpected redirect without following it', async () => {
  const { calls, fetchImpl } = queuedFetch([
    response(302, { redirected: true }),
    response(200),
  ]);

  const report = await runMonitor({
    baseUrl: BASE_URL,
    fetchImpl,
    maxAttempts: 1,
    sleepImpl: noSleep,
  });

  assert.equal(report.outcome, 'FAIL');
  assert.equal(report.attempts[0].results[0].code, 'UNEXPECTED_REDIRECT');
  assert.equal(calls[0].init.redirect, 'error');
});

test('rejects invalid or unsafe base URLs', () => {
  for (const value of [
    'http://monitor.example.test',
    'https://user:password@monitor.example.test',
    'https://monitor.example.test?token=private',
    'https://monitor.example.test/#private',
    'https://monitor.example.test/status',
    'not-a-url',
  ]) {
    assert.throws(() => validateBaseUrl(value), MonitoringInputError);
  }
});

test('caps an excessive requested retry count at the hard maximum', async () => {
  const { calls, fetchImpl } = queuedFetch(
    Array.from({ length: MONITOR_LIMITS.maxAttempts * MONITORED_ENDPOINTS.length }, () => response(503)),
  );

  const report = await runMonitor({
    baseUrl: BASE_URL,
    fetchImpl,
    maxAttempts: 99,
    sleepImpl: noSleep,
  });

  assert.equal(report.attempts.length, MONITOR_LIMITS.maxAttempts);
  assert.equal(calls.length, MONITOR_LIMITS.maxAttempts * MONITORED_ENDPOINTS.length);
});

test('never reads or includes an endpoint response body in diagnostics', async () => {
  const secretBody = 'private response body, cookie=secret-token';
  const first = response(503, { secretBody });
  const second = response(200);
  const { fetchImpl } = queuedFetch([first, second]);

  const report = await runMonitor({
    baseUrl: BASE_URL,
    fetchImpl,
    maxAttempts: 1,
    sleepImpl: noSleep,
  });

  assert.equal(first.bodyUsed, false);
  assert.equal(JSON.stringify(report).includes(secretBody), false);
});
