import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;
const MAX_HTML_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MIGRATION_FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;
const MIGRATION_IDENTIFIER_PATTERN = /^\d{14}_[a-z0-9_]+$/;

const repoRoot = path.resolve(__dirname, '../../../..');
export const DEFAULT_MIGRATIONS_DIRECTORY = path.resolve(
  repoRoot,
  'infra/supabase/migrations',
);

export type HostedSmokeClassification =
  | 'READY_FOR_SUPERVISED_UAT'
  | 'INVALID_INPUT'
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_FAILED'
  | 'CROSS_ORIGIN_REDIRECT_REJECTED'
  | 'REDIRECT_REJECTED'
  | 'RESPONSE_TOO_LARGE'
  | 'LIVENESS_FAILED'
  | 'READINESS_FAILED'
  | 'DEPLOYMENT_COMMIT_MISSING'
  | 'DEPLOYMENT_COMMIT_INVALID'
  | 'DEPLOYMENT_COMMIT_MISMATCH'
  | 'MIGRATION_EXPECTATION_UNAVAILABLE'
  | 'MIGRATION_EXPECTATION_MISMATCH'
  | 'LOGIN_SURFACE_FAILED';

export type RepositoryMigrationExpectation = {
  count: number;
  latest: string;
};

type DeploymentCommitEvidence =
  | { state: 'valid'; value: string }
  | { state: 'missing' | 'invalid' | 'unavailable' };

type RequestFailureKind =
  | 'timeout'
  | 'network'
  | 'cross-origin-redirect'
  | 'redirect'
  | 'response-too-large';

export type HostedSmokeRequestObservation = {
  method: 'GET' | 'HEAD';
  endpoint: '/api/health' | '/api/readiness' | '/login';
  status: number | null;
  durationMs: number;
  outcome: 'PASS' | 'FAIL';
  detail: string;
};

export type HostedSmokeReport = {
  baseHost: string;
  classification: HostedSmokeClassification;
  deploymentCommit: DeploymentCommitEvidence;
  expectedCommit?: string;
  repositoryMigrations: RepositoryMigrationExpectation | null;
  observedMigrations: RepositoryMigrationExpectation | null;
  requests: HostedSmokeRequestObservation[];
};

export type HostedSmokeCliOptions = {
  baseUrl: URL;
  expectedCommit?: string;
};

type RunHostedSmokeVerifierOptions = HostedSmokeCliOptions & {
  fetchImpl?: typeof fetch;
  migrationsDirectory?: string;
  requestTimeoutMs?: number;
  maxJsonResponseBytes?: number;
  maxHtmlResponseBytes?: number;
};

type RequestResult = {
  observation: HostedSmokeRequestObservation;
  headers: Headers | null;
  body: Uint8Array | null;
  failureKind?: RequestFailureKind;
};

type ReadinessEvidence = {
  commit: DeploymentCommitEvidence;
  migrations: RepositoryMigrationExpectation;
};

class RequestFailure extends Error {
  constructor(
    readonly kind: RequestFailureKind,
    readonly status: number | null,
  ) {
    super(kind);
  }
}

export class HostedSmokeInputError extends Error {
  constructor() {
    super('Invalid hosted smoke verifier input.');
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1'
  ) {
    return true;
  }

  const ipv4 = normalized.split('.').map(Number);
  return (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    ipv4[0] === 127
  );
}

export function parseHostedSmokeBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HostedSmokeInputError();
  }

  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    (parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new HostedSmokeInputError();
  }

  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}/`;
  return parsed;
}

export function parseHostedSmokeCliArgs(args: string[]): HostedSmokeCliOptions {
  let baseUrlValue: string | undefined;
  let expectedCommit: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--base-url=')) {
      if (baseUrlValue !== undefined) throw new HostedSmokeInputError();
      baseUrlValue = arg.slice('--base-url='.length);
    } else if (arg.startsWith('--expected-commit=')) {
      if (expectedCommit !== undefined) throw new HostedSmokeInputError();
      expectedCommit = arg.slice('--expected-commit='.length);
    } else {
      throw new HostedSmokeInputError();
    }
  }

  if (!baseUrlValue || (expectedCommit !== undefined && !SHA_PATTERN.test(expectedCommit))) {
    throw new HostedSmokeInputError();
  }

  return {
    baseUrl: parseHostedSmokeBaseUrl(baseUrlValue),
    expectedCommit: expectedCommit?.toLowerCase(),
  };
}

export function loadRepositoryMigrationExpectation(
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): RepositoryMigrationExpectation {
  const migrations = fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  if (
    migrations.length === 0 ||
    migrations.some((migration) => !MIGRATION_FILE_PATTERN.test(migration))
  ) {
    throw new Error('Repository migration inventory is unavailable.');
  }

  return {
    count: migrations.length,
    latest: migrations[migrations.length - 1].replace(/\.sql$/, ''),
  };
}

function endpointUrl(baseUrl: URL, endpoint: HostedSmokeRequestObservation['endpoint']): URL {
  return new URL(endpoint.replace(/^\//, ''), baseUrl);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function normalizedEndpointPath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
}

function parseContentLength(headers: Headers): number | null {
  const value = headers.get('content-length');
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = parseContentLength(response.headers);
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new RequestFailure('response-too-large', response.status);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestFailure('response-too-large', response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function detectHeadBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new Uint8Array();
      if (value.byteLength > 0) {
        await reader.cancel();
        return new Uint8Array([1]);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function requestEndpoint(
  baseUrl: URL,
  method: HostedSmokeRequestObservation['method'],
  endpoint: HostedSmokeRequestObservation['endpoint'],
  maxBytes: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<RequestResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let status: number | null = null;

  try {
    let currentUrl = endpointUrl(baseUrl, endpoint);
    const allowedPath = normalizedEndpointPath(currentUrl.pathname);
    let response: Response | null = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      response = await fetchImpl(currentUrl, {
        method,
        body: undefined,
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          Accept: endpoint === '/login' ? 'text/html' : 'application/json',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      status = response.status;

      if (!isRedirect(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new RequestFailure('redirect', response.status);

      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        throw new RequestFailure('redirect', response.status);
      }
      if (target.origin !== baseUrl.origin) {
        throw new RequestFailure('cross-origin-redirect', response.status);
      }
      if (
        target.username !== '' ||
        target.password !== '' ||
        target.search !== '' ||
        target.hash !== '' ||
        normalizedEndpointPath(target.pathname) !== allowedPath
      ) {
        throw new RequestFailure('redirect', response.status);
      }
      if (redirectCount === MAX_REDIRECTS) {
        throw new RequestFailure('redirect', response.status);
      }
      currentUrl = target;
    }

    if (!response) throw new RequestFailure('network', status);
    const body = method === 'HEAD'
      ? await detectHeadBody(response)
      : await readBoundedBody(response, maxBytes);
    return {
      observation: {
        method,
        endpoint,
        status: response.status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: 'FAIL',
        detail: 'NOT_EVALUATED',
      },
      headers: response.headers,
      body,
    };
  } catch (error) {
    const failure = error instanceof RequestFailure
      ? error
      : new RequestFailure(controller.signal.aborted ? 'timeout' : 'network', status);
    return {
      observation: {
        method,
        endpoint,
        status: failure.status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: 'FAIL',
        detail: failure.kind.toUpperCase().replaceAll('-', '_'),
      },
      headers: null,
      body: null,
      failureKind: failure.kind,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function hasNoStoreHeaders(headers: Headers | null): boolean {
  if (!headers) return false;
  const cacheControl = headers.get('cache-control')?.toLowerCase() ?? '';
  const pragma = headers.get('pragma')?.toLowerCase() ?? '';
  return cacheControl.split(',').some((part) => part.trim() === 'no-store') &&
    pragma.split(',').some((part) => part.trim() === 'no-cache');
}

function hasJsonContentType(headers: Headers | null): boolean {
  return headers?.get('content-type')?.toLowerCase().startsWith('application/json') ?? false;
}

function decodeBody(body: Uint8Array | null): string | null {
  return body === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(body);
}

function parseJsonObject(body: Uint8Array | null): Record<string, unknown> | null {
  try {
    const decoded = decodeBody(body);
    if (decoded === null) return null;
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function markObservation(
  request: RequestResult,
  passes: boolean,
  passDetail: string,
  failDetail: string,
): boolean {
  if (request.failureKind) return false;
  request.observation.outcome = passes ? 'PASS' : 'FAIL';
  request.observation.detail = passes ? passDetail : failDetail;
  return passes;
}

function evaluateHealthGet(request: RequestResult): boolean {
  const body = parseJsonObject(request.body);
  const exactBody = body !== null &&
    Object.keys(body).length === 2 &&
    body.app === 'admin-cms' &&
    body.status === 'ok';
  return markObservation(
    request,
    request.observation.status === 200 &&
      hasNoStoreHeaders(request.headers) &&
      hasJsonContentType(request.headers) &&
      exactBody,
    'LIVENESS_OK',
    'LIVENESS_CONTRACT_FAILED',
  );
}

function evaluateHead(
  request: RequestResult,
  expectedStatus: number | null,
  passDetail: string,
  failDetail: string,
): boolean {
  const bodyless = request.body?.byteLength === 0;
  return markObservation(
    request,
    expectedStatus !== null &&
      request.observation.status === expectedStatus &&
      hasNoStoreHeaders(request.headers) &&
      bodyless,
    passDetail,
    failDetail,
  );
}

function parseCommitEvidence(value: unknown): DeploymentCommitEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: 'invalid' };
  }
  const state = (value as Record<string, unknown>).state;
  if (state === 'missing') return { state: 'missing' };
  if (state === 'invalid') return { state: 'invalid' };
  const commit = (value as Record<string, unknown>).value;
  return state === 'valid' && typeof commit === 'string' && SHA_PATTERN.test(commit)
    ? { state: 'valid', value: commit.toLowerCase() }
    : { state: 'invalid' };
}

function parseMigrationEvidence(value: unknown): RepositoryMigrationExpectation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const migration = value as Record<string, unknown>;
  return Number.isSafeInteger(migration.count) &&
    (migration.count as number) > 0 &&
    typeof migration.latest === 'string' &&
    MIGRATION_IDENTIFIER_PATTERN.test(migration.latest)
    ? { count: migration.count as number, latest: migration.latest }
    : null;
}

function evaluateReadinessGet(request: RequestResult): ReadinessEvidence | null {
  const body = parseJsonObject(request.body);
  if (
    !body ||
    body.app !== 'admin-cms' ||
    !hasNoStoreHeaders(request.headers) ||
    !hasJsonContentType(request.headers)
  ) {
    markObservation(request, false, 'READINESS_READY', 'READINESS_CONTRACT_FAILED');
    return null;
  }

  const migrations = parseMigrationEvidence(body.expectedMigrations);
  const commit = parseCommitEvidence(body.deploymentCommit);
  const ready = request.observation.status === 200 &&
    body.readiness === 'ready' &&
    body.classification === 'READY' &&
    body.configuration === 'configured' &&
    body.dependency === 'reachable';
  const configurationNotReady = request.observation.status === 503 &&
    body.readiness === 'not-ready' &&
    body.classification === 'CONFIGURATION_NOT_READY' &&
    body.configuration === 'not-ready' &&
    body.dependency === 'not-checked';
  const dependencyNotReady = request.observation.status === 503 &&
    body.readiness === 'not-ready' &&
    body.classification === 'DEPENDENCY_NOT_READY' &&
    body.configuration === 'configured' &&
    body.dependency === 'not-ready';
  const structurallyValid = migrations !== null &&
    (commit.state !== 'invalid' ||
      (typeof body.deploymentCommit === 'object' &&
        body.deploymentCommit !== null &&
        (body.deploymentCommit as Record<string, unknown>).state === 'invalid')) &&
    (ready || configurationNotReady || dependencyNotReady);

  markObservation(
    request,
    structurallyValid && ready,
    'READINESS_READY',
    structurallyValid ? 'READINESS_NOT_READY' : 'READINESS_CONTRACT_FAILED',
  );
  return structurallyValid && migrations ? { commit, migrations } : null;
}

function evaluateLoginGet(request: RequestResult): boolean {
  let html = '';
  try {
    html = decodeBody(request.body) ?? '';
  } catch {
    html = '';
  }
  const contentType = request.headers?.get('content-type')?.toLowerCase() ?? '';
  const isHtml = contentType.startsWith('text/html') &&
    /<!doctype\s+html|<html(?:\s|>)/i.test(html);
  const status = request.observation.status;
  return markObservation(
    request,
    status !== null && status >= 200 && status < 300 && isHtml,
    'LOGIN_HTML_OK',
    'LOGIN_SURFACE_CONTRACT_FAILED',
  );
}

function requestFailureClassification(requests: RequestResult[]): HostedSmokeClassification | null {
  const failureKinds = new Set(requests.map((request) => request.failureKind).filter(Boolean));
  if (failureKinds.has('cross-origin-redirect')) return 'CROSS_ORIGIN_REDIRECT_REJECTED';
  if (failureKinds.has('timeout')) return 'NETWORK_TIMEOUT';
  if (failureKinds.has('response-too-large')) return 'RESPONSE_TOO_LARGE';
  if (failureKinds.has('redirect')) return 'REDIRECT_REJECTED';
  if (failureKinds.has('network')) return 'NETWORK_FAILED';
  return null;
}

export async function runHostedSmokeVerifier({
  baseUrl,
  expectedCommit,
  fetchImpl = fetch,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxJsonResponseBytes = MAX_JSON_RESPONSE_BYTES,
  maxHtmlResponseBytes = MAX_HTML_RESPONSE_BYTES,
}: RunHostedSmokeVerifierOptions): Promise<HostedSmokeReport> {
  const verifiedBaseUrl = parseHostedSmokeBaseUrl(baseUrl.href);
  if (expectedCommit !== undefined && !SHA_PATTERN.test(expectedCommit)) {
    throw new HostedSmokeInputError();
  }
  const normalizedExpectedCommit = expectedCommit?.toLowerCase();

  let repositoryMigrations: RepositoryMigrationExpectation | null = null;
  try {
    repositoryMigrations = loadRepositoryMigrationExpectation(migrationsDirectory);
  } catch {
    // The report remains bounded and fails closed without exposing a local path.
  }

  const healthGet = await requestEndpoint(
    verifiedBaseUrl,
    'GET',
    '/api/health',
    maxJsonResponseBytes,
    requestTimeoutMs,
    fetchImpl,
  );
  const healthHead = await requestEndpoint(
    verifiedBaseUrl,
    'HEAD',
    '/api/health',
    0,
    requestTimeoutMs,
    fetchImpl,
  );
  const readinessGet = await requestEndpoint(
    verifiedBaseUrl,
    'GET',
    '/api/readiness',
    maxJsonResponseBytes,
    requestTimeoutMs,
    fetchImpl,
  );
  const readinessHead = await requestEndpoint(
    verifiedBaseUrl,
    'HEAD',
    '/api/readiness',
    0,
    requestTimeoutMs,
    fetchImpl,
  );
  const loginGet = await requestEndpoint(
    verifiedBaseUrl,
    'GET',
    '/login',
    maxHtmlResponseBytes,
    requestTimeoutMs,
    fetchImpl,
  );
  const requests = [healthGet, healthHead, readinessGet, readinessHead, loginGet];

  const healthGetReady = evaluateHealthGet(healthGet);
  const healthHeadReady = evaluateHead(
    healthHead,
    200,
    'LIVENESS_HEAD_OK',
    'LIVENESS_HEAD_CONTRACT_FAILED',
  );
  const readiness = evaluateReadinessGet(readinessGet);
  const readinessHeadReady = evaluateHead(
    readinessHead,
    readinessGet.observation.status,
    'READINESS_HEAD_OK',
    'READINESS_HEAD_CONTRACT_FAILED',
  );
  const loginReady = evaluateLoginGet(loginGet);

  let classification = requestFailureClassification(requests);
  if (!classification && (!healthGetReady || !healthHeadReady)) classification = 'LIVENESS_FAILED';
  if (!classification && (!readiness || readinessGet.observation.outcome !== 'PASS' || !readinessHeadReady)) {
    classification = 'READINESS_FAILED';
  }

  const deploymentCommit = readiness?.commit ?? { state: 'unavailable' as const };
  const observedMigrations = readiness?.migrations ?? null;
  if (!classification && deploymentCommit.state === 'missing') {
    classification = 'DEPLOYMENT_COMMIT_MISSING';
  }
  if (!classification && deploymentCommit.state === 'invalid') {
    classification = 'DEPLOYMENT_COMMIT_INVALID';
  }
  if (
    !classification &&
    normalizedExpectedCommit &&
    deploymentCommit.state === 'valid' &&
    deploymentCommit.value !== normalizedExpectedCommit
  ) {
    classification = 'DEPLOYMENT_COMMIT_MISMATCH';
  }
  if (!classification && !repositoryMigrations) {
    classification = 'MIGRATION_EXPECTATION_UNAVAILABLE';
  }
  if (
    !classification &&
    repositoryMigrations &&
    observedMigrations &&
    (repositoryMigrations.count !== observedMigrations.count ||
      repositoryMigrations.latest !== observedMigrations.latest)
  ) {
    classification = 'MIGRATION_EXPECTATION_MISMATCH';
  }
  if (!classification && !loginReady) classification = 'LOGIN_SURFACE_FAILED';

  return {
    baseHost: verifiedBaseUrl.host,
    classification: classification ?? 'READY_FOR_SUPERVISED_UAT',
    deploymentCommit,
    expectedCommit: normalizedExpectedCommit,
    repositoryMigrations,
    observedMigrations,
    requests: requests.map((request) => request.observation),
  };
}

function migrationSummary(migrations: RepositoryMigrationExpectation | null): string {
  return migrations
    ? `count=${migrations.count} latest=${migrations.latest}`
    : 'UNAVAILABLE';
}

export function formatHostedSmokeReport(report: HostedSmokeReport): string {
  const lines = [
    'HOSTED DEPLOYMENT / UAT SMOKE (READ-ONLY)',
    `BASE_HOST = ${report.baseHost}`,
    'HTTP_METHODS = GET, HEAD',
    `REPOSITORY_MIGRATIONS = ${migrationSummary(report.repositoryMigrations)}`,
    `READINESS_MIGRATIONS = ${migrationSummary(report.observedMigrations)}`,
    `DEPLOYMENT_COMMIT_STATE = ${report.deploymentCommit.state.toUpperCase()}`,
  ];

  if (report.deploymentCommit.state === 'valid') {
    lines.push(`DEPLOYMENT_COMMIT = ${report.deploymentCommit.value}`);
  }
  if (report.expectedCommit) lines.push(`EXPECTED_COMMIT = ${report.expectedCommit}`);

  for (const request of report.requests) {
    lines.push(
      `REQUEST ${request.method} ${request.endpoint} status=${request.status ?? 'UNAVAILABLE'} ` +
      `duration_ms=${request.durationMs} result=${request.outcome} detail=${request.detail}`,
    );
  }

  lines.push('HOSTED_MUTATIONS = NONE');
  lines.push(`HOSTED_SMOKE_CLASSIFICATION = ${report.classification}`);
  return lines.join('\n');
}

export function formatInvalidHostedSmokeInput(): string {
  return [
    'HOSTED DEPLOYMENT / UAT SMOKE (READ-ONLY)',
    'BASE_HOST = INVALID',
    'USAGE = --base-url=https://host.example [--expected-commit=<40-hex-sha>]',
    'HOSTED_MUTATIONS = NONE',
    'HOSTED_SMOKE_CLASSIFICATION = INVALID_INPUT',
  ].join('\n');
}
