import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MONITORED_ENDPOINTS = Object.freeze([
  '/api/health',
  '/api/readiness',
]);

export const MONITOR_LIMITS = Object.freeze({
  maxAttempts: 5,
  maxRequestTimeoutMs: 15_000,
  maxRetryDelayMs: 30_000,
  defaultRequestTimeoutMs: 10_000,
  defaultRetryDelayMs: 15_000,
});

export class MonitoringInputError extends Error {
  constructor() {
    super('Invalid staging monitoring input.');
    this.name = 'MonitoringInputError';
  }
}

function validatePositiveInteger(value, maximum, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new MonitoringInputError();
  }
  return Math.min(value, maximum);
}

export function validateBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MonitoringInputError();
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MonitoringInputError();
  }

  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || url.pathname !== '/'
  ) {
    throw new MonitoringInputError();
  }

  return url;
}

function failureCodeFromError({ timedOut }) {
  return timedOut ? 'TIMEOUT' : 'TRANSPORT_FAILURE';
}

async function probeEndpoint(baseUrl, endpoint, { fetchImpl, requestTimeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);

  try {
    const response = await fetchImpl(new URL(endpoint, baseUrl), {
      method: 'HEAD',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return {
        endpoint,
        outcome: 'FAIL',
        status: Number.isInteger(response.status) ? response.status : null,
        code: 'UNEXPECTED_REDIRECT',
      };
    }

    if (response.status !== 200) {
      return {
        endpoint,
        outcome: 'FAIL',
        status: Number.isInteger(response.status) ? response.status : null,
        code: Number.isInteger(response.status) ? 'UNEXPECTED_STATUS' : 'UNEXPECTED_RESPONSE',
      };
    }

    return {
      endpoint,
      outcome: 'PASS',
      status: 200,
      code: 'HTTP_200',
    };
  } catch {
    return {
      endpoint,
      outcome: 'FAIL',
      status: null,
      code: failureCodeFromError({ timedOut }),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runMonitor({
  baseUrl,
  fetchImpl = globalThis.fetch,
  maxAttempts = MONITOR_LIMITS.maxAttempts,
  requestTimeoutMs = MONITOR_LIMITS.defaultRequestTimeoutMs,
  retryDelayMs = MONITOR_LIMITS.defaultRetryDelayMs,
  sleepImpl = defaultSleep,
} = {}) {
  const validatedBaseUrl = validateBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function' || typeof sleepImpl !== 'function') {
    throw new MonitoringInputError();
  }

  const boundedAttempts = validatePositiveInteger(maxAttempts, MONITOR_LIMITS.maxAttempts);
  const boundedTimeout = validatePositiveInteger(
    requestTimeoutMs,
    MONITOR_LIMITS.maxRequestTimeoutMs,
  );
  const boundedDelay = validatePositiveInteger(
    retryDelayMs,
    MONITOR_LIMITS.maxRetryDelayMs,
    true,
  );
  const attempts = [];

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    const results = await Promise.all(
      MONITORED_ENDPOINTS.map((endpoint) => probeEndpoint(validatedBaseUrl, endpoint, {
        fetchImpl,
        requestTimeoutMs: boundedTimeout,
      })),
    );
    attempts.push({ attempt, results });

    if (results.every((result) => result.outcome === 'PASS')) {
      return {
        outcome: 'PASS',
        attempts,
      };
    }

    if (attempt < boundedAttempts) {
      await sleepImpl(boundedDelay);
    }
  }

  return {
    outcome: 'FAIL',
    attempts,
  };
}

function formatResult(report) {
  const finalAttempt = report.attempts.at(-1);
  const endpointSummary = finalAttempt?.results
    .map((result) => `${result.endpoint}=${result.status ?? result.code}`)
    .join(',') ?? 'none';
  return [
    `STAGING_MONITOR outcome=${report.outcome}`,
    `attempts=${report.attempts.length}/${MONITOR_LIMITS.maxAttempts}`,
    `endpoints=${endpointSummary}`,
  ].join(' ');
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) {
    console.error('STAGING_MONITOR outcome=FAIL code=INVALID_INPUT');
    return 1;
  }

  try {
    const report = await runMonitor({ baseUrl: args[0] });
    console.log(formatResult(report));
    return report.outcome === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(
      `STAGING_MONITOR outcome=FAIL code=${error instanceof MonitoringInputError ? 'INVALID_INPUT' : 'MONITOR_ERROR'}`,
    );
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
