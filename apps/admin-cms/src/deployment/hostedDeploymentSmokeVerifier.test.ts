import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatHostedSmokeReport,
  loadRepositoryMigrationExpectation,
  parseHostedSmokeBaseUrl,
  parseHostedSmokeCliArgs,
  runHostedSmokeVerifier,
} from './hostedDeploymentSmokeVerifier';

const VALID_COMMIT = 'a75f4d8861ce693ddd264f9797d8af656911154f';
const OTHER_VALID_COMMIT = 'b86f4d8861ce693ddd264f9797d8af656911154f';
const REPOSITORY_MIGRATIONS = loadRepositoryMigrationExpectation();

type ReadinessBody = {
  app: string;
  readiness: string;
  classification: string;
  configuration: string;
  dependency: string;
  deploymentCommit: unknown;
  expectedMigrations: unknown;
};

type FixtureOptions = {
  healthStatus?: number;
  healthBody?: unknown;
  healthRawBody?: string;
  healthContentType?: string;
  readinessStatus?: number;
  readinessHeadStatus?: number;
  readinessBody?: ReadinessBody;
  readinessRawBody?: string;
  readinessContentType?: string;
  loginStatus?: number;
  loginContentType?: string;
  loginBody?: string;
  loginRedirect?: 'external' | 'localhost' | 'private-route';
  oversizedEndpoint?: '/api/health' | '/api/readiness' | '/login';
  delayedEndpoint?: '/api/health' | '/api/readiness' | '/login';
  delayMs?: number;
};

type ObservedRequest = {
  method: string;
  pathname: string;
  authorization?: string;
  cookie?: string;
  contentLength?: string;
};

type Fixture = {
  baseUrl: URL;
  requests: ObservedRequest[];
};

const servers: Server[] = [];

function readyBody(overrides: Partial<ReadinessBody> = {}): ReadinessBody {
  return {
    app: 'admin-cms',
    readiness: 'ready',
    classification: 'READY',
    configuration: 'configured',
    dependency: 'reachable',
    deploymentCommit: { state: 'valid', value: VALID_COMMIT },
    expectedMigrations: REPOSITORY_MIGRATIONS,
    ...overrides,
  };
}

function addNoStoreHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
}

function sendBody(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  method: string,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  if (method === 'HEAD') response.end();
  else response.end(body);
}

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    const method = request.method ?? '';
    const pathname = new URL(request.url ?? '/', 'http://fixture.local').pathname;
    requests.push({
      method,
      pathname,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      contentLength: request.headers['content-length'],
    });

    if (options.delayedEndpoint === pathname) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 100));
    }

    if (options.oversizedEndpoint === pathname && method !== 'HEAD') {
      const body = 'x'.repeat(70 * 1024);
      if (pathname !== '/login') addNoStoreHeaders(response);
      sendBody(
        response,
        200,
        pathname === '/login' ? 'text/html' : 'application/json',
        body,
        method,
      );
      return;
    }

    if (pathname === '/api/health') {
      addNoStoreHeaders(response);
      const body = options.healthRawBody ?? JSON.stringify(
        options.healthBody ?? { app: 'admin-cms', status: 'ok' },
      );
      sendBody(
        response,
        options.healthStatus ?? 200,
        options.healthContentType ?? 'application/json',
        body,
        method,
      );
      return;
    }

    if (pathname === '/api/readiness') {
      addNoStoreHeaders(response);
      const body = options.readinessRawBody ?? JSON.stringify(
        options.readinessBody ?? readyBody(),
      );
      const status = method === 'HEAD'
        ? options.readinessHeadStatus ?? options.readinessStatus ?? 200
        : options.readinessStatus ?? 200;
      sendBody(
        response,
        status,
        options.readinessContentType ?? 'application/json',
        body,
        method,
      );
      return;
    }

    if (pathname === '/login') {
      if (options.loginRedirect) {
        const address = server.address() as AddressInfo;
        response.statusCode = 302;
        response.setHeader(
          'Location',
          options.loginRedirect === 'external'
            ? 'https://outside.example/login'
            : options.loginRedirect === 'localhost'
              ? `http://localhost:${address.port}/login`
              : '/api/projects',
        );
        response.end();
        return;
      }
      sendBody(
        response,
        options.loginStatus ?? 200,
        options.loginContentType ?? 'text/html; charset=utf-8',
        options.loginBody ?? '<!doctype html><html><body>Sign in</body></html>',
        method,
      );
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: parseHostedSmokeBaseUrl(`http://127.0.0.1:${port}`),
    requests,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe('hosted deployment smoke verifier input', () => {
  it('normalizes HTTPS and explicit loopback fixture base URLs', () => {
    expect(parseHostedSmokeBaseUrl('https://staging.example/').href).toBe(
      'https://staging.example/',
    );
    expect(parseHostedSmokeBaseUrl('http://127.0.0.1:4312/app///').href).toBe(
      'http://127.0.0.1:4312/app/',
    );
  });

  it.each([
    ['http://staging.example'],
    ['https://user:password@staging.example'],
    ['https://staging.example?token=private'],
    ['https://staging.example#private'],
  ])('rejects an unsafe base URL without reflecting it: %s', (value) => {
    expect(() => parseHostedSmokeBaseUrl(value)).toThrow();
  });

  it('accepts only the explicit base URL and optional valid full commit options', () => {
    expect(parseHostedSmokeCliArgs([
      '--base-url=https://staging.example',
      `--expected-commit=${VALID_COMMIT.toUpperCase()}`,
    ])).toMatchObject({ expectedCommit: VALID_COMMIT });
    expect(() => parseHostedSmokeCliArgs([])).toThrow();
    expect(() => parseHostedSmokeCliArgs([
      '--base-url=https://staging.example',
      '--token=private',
    ])).toThrow();
    expect(() => parseHostedSmokeCliArgs([
      '--base-url=https://staging.example',
      '--expected-commit=short',
    ])).toThrow();
  });
});

describe('hosted deployment smoke verifier synthetic HTTP evidence', () => {
  it('classifies a healthy deployment as ready for supervised UAT', async () => {
    const fixture = await startFixture();
    const report = await runHostedSmokeVerifier({
      baseUrl: fixture.baseUrl,
      expectedCommit: VALID_COMMIT,
    });

    expect(report.classification).toBe('READY_FOR_SUPERVISED_UAT');
    expect(report.repositoryMigrations).toEqual(REPOSITORY_MIGRATIONS);
    expect(report.observedMigrations).toEqual(REPOSITORY_MIGRATIONS);
    expect(report.requests).toHaveLength(5);
    expect(report.requests.every(({ outcome }) => outcome === 'PASS')).toBe(true);
  });

  it('fails on a health response outside the exact liveness contract', async () => {
    const fixture = await startFixture({ healthStatus: 500 });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('LIVENESS_FAILED');
  });

  it('reports a structurally consistent readiness 503 as not ready', async () => {
    const fixture = await startFixture({
      readinessStatus: 503,
      readinessBody: readyBody({
        readiness: 'not-ready',
        classification: 'DEPENDENCY_NOT_READY',
        configuration: 'configured',
        dependency: 'not-ready',
      }),
    });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('READINESS_FAILED');
    expect(report.requests.find(({ method, endpoint }) =>
      method === 'HEAD' && endpoint === '/api/readiness')?.status).toBe(503);
  });

  it('fails closed on malformed readiness JSON without printing the body', async () => {
    const fixture = await startFixture({
      readinessRawBody: 'private malformed readiness response',
    });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });
    const formatted = formatHostedSmokeReport(report);

    expect(report.classification).toBe('READINESS_FAILED');
    expect(formatted).not.toContain('private malformed readiness response');
  });

  it('rejects readiness data served with a non-JSON content type', async () => {
    const fixture = await startFixture({ readinessContentType: 'text/plain' });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('READINESS_FAILED');
  });

  it('rejects an oversized response before interpreting it', async () => {
    const fixture = await startFixture({ oversizedEndpoint: '/api/health' });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('RESPONSE_TOO_LARGE');
  });

  it('classifies a bounded request timeout distinctly', async () => {
    const fixture = await startFixture({
      delayedEndpoint: '/api/health',
      delayMs: 100,
    });
    const report = await runHostedSmokeVerifier({
      baseUrl: fixture.baseUrl,
      requestTimeoutMs: 10,
    });

    expect(report.classification).toBe('NETWORK_TIMEOUT');
  });

  it('rejects an external redirect without following it', async () => {
    const fixture = await startFixture({ loginRedirect: 'external' });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('CROSS_ORIGIN_REDIRECT_REJECTED');
    expect(fixture.requests.filter(({ pathname }) => pathname === '/login')).toHaveLength(1);
  });

  it('rejects a redirect from the supplied loopback host to localhost', async () => {
    const fixture = await startFixture({ loginRedirect: 'localhost' });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('CROSS_ORIGIN_REDIRECT_REJECTED');
  });

  it('rejects a same-origin redirect to any route outside the checked endpoint', async () => {
    const fixture = await startFixture({ loginRedirect: 'private-route' });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('REDIRECT_REJECTED');
    expect(fixture.requests.some(({ pathname }) => pathname === '/api/projects')).toBe(false);
  });

  it('distinguishes repository migration count mismatch', async () => {
    const fixture = await startFixture({
      readinessBody: readyBody({
        expectedMigrations: {
          count: REPOSITORY_MIGRATIONS.count + 1,
          latest: REPOSITORY_MIGRATIONS.latest,
        },
      }),
    });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('MIGRATION_EXPECTATION_MISMATCH');
  });

  it('distinguishes repository latest-migration mismatch', async () => {
    const fixture = await startFixture({
      readinessBody: readyBody({
        expectedMigrations: {
          count: REPOSITORY_MIGRATIONS.count,
          latest: '20990101000000_future_migration',
        },
      }),
    });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('MIGRATION_EXPECTATION_MISMATCH');
  });

  it('accepts an exact valid expected deployment commit', async () => {
    const fixture = await startFixture();
    const report = await runHostedSmokeVerifier({
      baseUrl: fixture.baseUrl,
      expectedCommit: VALID_COMMIT,
    });

    expect(report.classification).toBe('READY_FOR_SUPERVISED_UAT');
    expect(report.deploymentCommit).toEqual({ state: 'valid', value: VALID_COMMIT });
  });

  it('distinguishes missing deployment commit evidence', async () => {
    const fixture = await startFixture({
      readinessBody: readyBody({ deploymentCommit: { state: 'missing' } }),
    });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('DEPLOYMENT_COMMIT_MISSING');
  });

  it('distinguishes invalid deployment commit evidence', async () => {
    const fixture = await startFixture({
      readinessBody: readyBody({ deploymentCommit: { state: 'invalid' } }),
    });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('DEPLOYMENT_COMMIT_INVALID');
  });

  it('distinguishes an exact expected deployment commit mismatch', async () => {
    const fixture = await startFixture();
    const report = await runHostedSmokeVerifier({
      baseUrl: fixture.baseUrl,
      expectedCommit: OTHER_VALID_COMMIT,
    });

    expect(report.classification).toBe('DEPLOYMENT_COMMIT_MISMATCH');
  });

  it('enforces the health HEAD body contract', async () => {
    const fixture = await startFixture();
    const fetchWithInvalidHeadBody: typeof fetch = async (input, init) => {
      const requestUrl = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      if (init?.method === 'HEAD' && requestUrl.pathname === '/api/health') {
        return new Response('unexpected body', {
          status: 200,
          headers: {
            'Cache-Control': 'no-store, max-age=0',
            Pragma: 'no-cache',
          },
        });
      }
      return fetch(input, init);
    };
    const report = await runHostedSmokeVerifier({
      baseUrl: fixture.baseUrl,
      fetchImpl: fetchWithInvalidHeadBody,
    });

    expect(report.classification).toBe('LIVENESS_FAILED');
  });

  it('enforces the readiness HEAD status contract', async () => {
    const fixture = await startFixture({ readinessHeadStatus: 503 });
    const report = await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(report.classification).toBe('READINESS_FAILED');
  });

  it('issues only the five allowed bodyless GET/HEAD requests without credentials', async () => {
    const fixture = await startFixture();
    await runHostedSmokeVerifier({ baseUrl: fixture.baseUrl });

    expect(fixture.requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
      'GET /api/health',
      'HEAD /api/health',
      'GET /api/readiness',
      'HEAD /api/readiness',
      'GET /login',
    ]);
    expect(fixture.requests.every(({ method }) => method === 'GET' || method === 'HEAD')).toBe(true);
    expect(fixture.requests.every(({ authorization, cookie, contentLength }) =>
      authorization === undefined && cookie === undefined && contentLength === undefined)).toBe(true);
  });
});
