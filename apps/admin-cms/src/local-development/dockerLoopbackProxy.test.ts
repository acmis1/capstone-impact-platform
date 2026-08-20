import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCKER_PROXY_AUTH_HEADER,
  MAX_DOCKER_CREATE_BODY_BYTES,
  dockerEndpoint,
  npipePath,
} from './dockerLoopbackProxy';
import {
  dockerProxyCustomHeaders,
  LOCAL_DOCKER_NETWORK_NAME,
  safeProcessResult,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
  type DockerProxyHandle,
} from './safeSupabaseCli';

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface ProxyResponse {
  statusCode: number;
  body: Buffer;
}

const authorizationToken = 'synthetic-static-proxy-authorization-fixture';
const repoRoot = path.resolve(__dirname, '../../../..');
const recordedRequests: RecordedRequest[] = [];
const recordedUpgrades: RecordedRequest[] = [];
let fakeDaemonDirectory: string;
let fakeDaemonPath: string;
let fakeDaemonTarget: string;
let fakeDaemon: http.Server;
let proxy: DockerProxyHandle | undefined;

function listen(server: http.Server, listenPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMilliseconds = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SYNTHETIC_PROCESS_EXIT_TIMED_OUT')), timeoutMilliseconds);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function expectProxyEndpointClosed(listenPath: string, timeoutMilliseconds = 1_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(listenPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('SYNTHETIC_PROXY_ENDPOINT_CHECK_TIMED_OUT'));
    }, timeoutMilliseconds);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.once('connect', () => finish(new Error('SYNTHETIC_PROXY_ENDPOINT_STILL_ACCEPTING_CONNECTIONS')));
    socket.once('error', () => finish());
    socket.once('close', () => finish());
  });
}

async function waitForCondition(condition: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMilliseconds) throw new Error('SYNTHETIC_CONDITION_TIMED_OUT');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeTestPath(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    // Exact test-owned cleanup is intentionally idempotent.
  }
}

function requestProxy(options: {
  method?: string;
  requestPath?: string;
  token?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: Buffer | string;
  chunked?: boolean;
} = {}): Promise<ProxyResponse> {
  if (!proxy) throw new Error('SYNTHETIC_PROXY_NOT_RUNNING');
  const headers: http.OutgoingHttpHeaders = { ...options.headers };
  if (options.token !== undefined) headers[DOCKER_PROXY_AUTH_HEADER] = options.token;
  if (options.body !== undefined && !options.chunked && headers['content-length'] === undefined) {
    headers['content-length'] = Buffer.byteLength(options.body);
  }

  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: proxy?.listenPath,
      method: options.method ?? 'GET',
      path: options.requestPath ?? '/_ping',
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
      }));
    });
    request.once('error', reject);
    if (options.body === undefined) {
      request.end();
    } else if (options.chunked) {
      const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
      const midpoint = Math.max(1, Math.floor(body.length / 2));
      request.write(body.subarray(0, midpoint));
      request.end(body.subarray(midpoint));
    } else {
      request.end(options.body);
    }
  });
}

function rawProxyRequest(lines: string[], partialBody?: string): Promise<string> {
  if (!proxy) throw new Error('SYNTHETIC_PROXY_NOT_RUNNING');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(proxy?.listenPath ?? '', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n${partialBody ?? ''}`);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function interruptCreateRequest(): Promise<void> {
  if (!proxy) throw new Error('SYNTHETIC_PROXY_NOT_RUNNING');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(proxy?.listenPath ?? '', () => {
      socket.write([
        'POST /v1.47/containers/create HTTP/1.1',
        'Host: synthetic-daemon',
        `${DOCKER_PROXY_AUTH_HEADER}: ${authorizationToken}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{"HostConfig":',
      ].join('\r\n'));
      socket.destroy();
    });
    socket.once('error', reject);
    socket.once('close', () => resolve());
  });
}

function runPinnedSupabaseCli(args: string[]): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  if (!proxy) throw new Error('SYNTHETIC_PROXY_NOT_RUNNING');
  const cliShim = path.join(repoRoot, 'node_modules/supabase/dist/supabase.js');
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_HOST: proxy.dockerHost,
    DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(process.env.DOCKER_CUSTOM_HEADERS, authorizationToken),
    SUPABASE_TELEMETRY_DISABLED: '1',
  };
  delete childEnvironment.CAPSTONE_DOCKER_PROXY_AUTHORIZATION;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliShim, ...args], {
      cwd: repoRoot,
      env: childEnvironment,
      stdio: 'ignore',
    });
    child.once('error', () => resolve({ exitCode: null, signal: null }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

beforeAll(async () => {
  fakeDaemonDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-fake-docker-'));
  const pipeIdentifier = `cip-fake-docker-${process.pid}-${Date.now()}`;
  fakeDaemonPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeIdentifier}`
    : path.join(fakeDaemonDirectory, 'docker.sock');

  fakeDaemon = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      recordedRequests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      if (request.url?.includes('/containers/json')) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' });
        response.end('[]');
      } else if (request.url?.endsWith('/_ping')) {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
        response.end('OK');
      } else if (request.url?.endsWith('/version')) {
        const body = JSON.stringify({ ApiVersion: '1.47', Version: 'synthetic' });
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
        response.end(body);
      } else {
        response.writeHead(204, { 'content-length': '0' });
        response.end();
      }
    });
  });
  fakeDaemon.on('upgrade', (request, socket, head) => {
    recordedUpgrades.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: head,
    });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: tcp\r\n\r\n');
  });
  await listen(fakeDaemon, fakeDaemonPath);

  fakeDaemonTarget = process.platform === 'win32'
    ? `npipe:////./pipe/${pipeIdentifier}`
    : `unix://${fakeDaemonPath}`;
  proxy = startDockerLoopbackProxy(repoRoot, { targetDockerHost: fakeDaemonTarget, authorizationToken });
});

afterAll(async () => {
  if (proxy) stopDockerLoopbackProxy(proxy);
  await close(fakeDaemon);
  if (process.platform !== 'win32' && fs.existsSync(fakeDaemonPath)) fs.unlinkSync(fakeDaemonPath);
  fs.rmdirSync(fakeDaemonDirectory);
});

describe.sequential('authenticated Docker loopback proxy', () => {
  it('rejects unauthenticated, invalid-token, and destructive requests before upstream', async () => {
    const upstreamCount = recordedRequests.length;
    const unauthenticated = await requestProxy();
    const invalid = await requestProxy({ token: 'synthetic-invalid-token' });
    const destructive = await requestProxy({
      method: 'DELETE',
      requestPath: '/v1.47/containers/synthetic?force=1',
    });

    expect([unauthenticated.statusCode, invalid.statusCode, destructive.statusCode]).toEqual([403, 403, 403]);
    expect([unauthenticated.body, invalid.body, destructive.body].every((body) => body.length === 0)).toBe(true);
    expect(recordedRequests).toHaveLength(upstreamCount);
  });

  it('forwards an authenticated Supabase-style request without forwarding the token', async () => {
    const response = await requestProxy({
      requestPath: '/v1.47/containers/json?all=1',
      token: authorizationToken,
    });
    const upstream = recordedRequests.at(-1);

    expect(response).toEqual({ statusCode: 200, body: Buffer.from('[]') });
    expect(upstream?.url).toBe('/v1.47/containers/json?all=1');
    expect(upstream?.headers[DOCKER_PROXY_AUTH_HEADER]).toBeUndefined();
  });

  it('rewrites a Content-Length create request with one correct framing header', async () => {
    const input = JSON.stringify({
      Image: 'synthetic-image',
      HostConfig: { PortBindings: { '8000/tcp': [{ HostIp: '', HostPort: '54321' }] } },
    });
    const response = await requestProxy({
      method: 'POST',
      requestPath: '/v1.47/containers/create?name=synthetic',
      token: authorizationToken,
      headers: { 'content-type': 'application/json' },
      body: input,
    });
    const upstream = recordedRequests.at(-1);
    const rewritten = JSON.parse(upstream?.body.toString('utf8') ?? '{}');

    expect(response.statusCode).toBe(204);
    expect(rewritten.HostConfig.PortBindings['8000/tcp'][0].HostIp).toBe('127.0.0.1');
    expect(upstream?.headers['transfer-encoding']).toBeUndefined();
    expect(upstream?.headers['content-length']).toBe(String(upstream?.body.length));
  });

  it('normalizes a chunked create request before forwarding', async () => {
    const input = JSON.stringify({
      HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '54322' }] } },
    });
    const response = await requestProxy({
      method: 'POST',
      requestPath: '/v1.47/containers/create',
      token: authorizationToken,
      headers: { 'content-type': 'application/json' },
      body: input,
      chunked: true,
    });
    const upstream = recordedRequests.at(-1);

    expect(response.statusCode).toBe(204);
    expect(upstream?.headers['transfer-encoding']).toBeUndefined();
    expect(upstream?.headers['content-length']).toBe(String(upstream?.body.length));
    expect(JSON.parse(upstream?.body.toString('utf8') ?? '{}').HostConfig.PortBindings['5432/tcp'][0].HostIp)
      .toBe('127.0.0.1');
  });

  it('fails closed for malformed, absent, interrupted, and oversized create bodies', async () => {
    const upstreamCount = recordedRequests.length;
    const malformed = await requestProxy({
      method: 'POST',
      requestPath: '/containers/create',
      token: authorizationToken,
      body: '{',
    });
    const absent = await requestProxy({
      method: 'POST',
      requestPath: '/containers/create',
      token: authorizationToken,
    });
    await interruptCreateRequest();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const oversized = await requestProxy({
      method: 'POST',
      requestPath: '/containers/create',
      token: authorizationToken,
      body: Buffer.alloc(MAX_DOCKER_CREATE_BODY_BYTES + 1, 0x20),
    });

    expect(malformed.statusCode).toBe(400);
    expect(absent.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(413);
    expect([malformed.body, absent.body, oversized.body].every((body) => body.length === 0)).toBe(true);
    expect(recordedRequests).toHaveLength(upstreamCount);
  });

  it('keeps non-rewritten request bodies streaming', async () => {
    const body = 'synthetic-streaming-body';
    const response = await requestProxy({
      method: 'POST',
      requestPath: '/v1.47/build',
      token: authorizationToken,
      body,
      chunked: true,
    });
    const upstream = recordedRequests.at(-1);

    expect(response.statusCode).toBe(204);
    expect(upstream?.body.toString('utf8')).toBe(body);
    expect(upstream?.headers['transfer-encoding']).toBe('chunked');
    expect(upstream?.headers[DOCKER_PROXY_AUTH_HEADER]).toBeUndefined();
  });

  it('requires authorization on upgrades and strips it on accepted upgrades', async () => {
    const upgradeCount = recordedUpgrades.length;
    const unauthenticated = await rawProxyRequest([
      'GET /v1.47/containers/synthetic/attach/ws HTTP/1.1',
      'Host: synthetic-daemon',
      'Connection: Upgrade',
      'Upgrade: tcp',
    ]);
    expect(unauthenticated).toContain('403 Forbidden');
    const rejected = await rawProxyRequest([
      'GET /v1.47/containers/synthetic/attach/ws HTTP/1.1',
      'Host: synthetic-daemon',
      'Connection: Upgrade',
      'Upgrade: tcp',
      `${DOCKER_PROXY_AUTH_HEADER}: synthetic-invalid-token`,
    ]);
    expect(rejected).toContain('403 Forbidden');
    expect(recordedUpgrades).toHaveLength(upgradeCount);

    const accepted = await rawProxyRequest([
      'GET /v1.47/containers/synthetic/attach/ws HTTP/1.1',
      'Host: synthetic-daemon',
      'Connection: Upgrade',
      'Upgrade: tcp',
      `${DOCKER_PROXY_AUTH_HEADER}: ${authorizationToken}`,
    ]);
    expect(accepted).toContain('101 Switching Protocols');
    expect(recordedUpgrades).toHaveLength(upgradeCount + 1);
    expect(recordedUpgrades.at(-1)?.headers[DOCKER_PROXY_AUTH_HEADER]).toBeUndefined();
  });

  it('accepts pinned-CLI status and stop traffic only through the injected custom header', async () => {
    for (const command of ['status', 'stop'] as const) {
      if (proxy && fs.existsSync(proxy.auditPath)) fs.unlinkSync(proxy.auditPath);
      const upstreamCount = recordedRequests.length;
      const result = await runPinnedSupabaseCli([
        command,
        '--workdir',
        'infra',
        '--network-id',
        LOCAL_DOCKER_NETWORK_NAME,
      ]);
      const acceptedRequests = recordedRequests.slice(upstreamCount);

      expect(result.signal).toBeNull();
      expect(fs.existsSync(proxy?.auditPath ?? '') ? fs.readFileSync(proxy?.auditPath ?? '', 'utf8') : 'NONE').toBe('NONE');
      expect(acceptedRequests.length).toBeGreaterThan(0);
      expect(acceptedRequests.every((request) => request.headers[DOCKER_PROXY_AUTH_HEADER] === undefined)).toBe(true);
    }
  });

  it('parses the pinned reset command without contacting Docker when help is requested', async () => {
    const upstreamCount = recordedRequests.length;
    const result = await runPinnedSupabaseCli([
      'db',
      'reset',
      '--local',
      '--workdir',
      'infra',
      '--network-id',
      LOCAL_DOCKER_NETWORK_NAME,
      '--help',
    ]);

    expect(result).toEqual({ exitCode: 0, signal: null });
    expect(recordedRequests).toHaveLength(upstreamCount);
  });

  it('uses private Unix resources and keeps public results token-free', () => {
    if (!proxy) throw new Error('SYNTHETIC_PROXY_NOT_RUNNING');
    if (process.platform !== 'win32') {
      expect(fs.statSync(proxy.temporaryDirectory).mode & 0o777).toBe(0o700);
      [
        proxy.readyPath,
        proxy.listenPath,
      ].forEach((file) => expect(fs.statSync(file).mode & 0o777).toBe(0o600));
      if (fs.existsSync(proxy.auditPath)) expect(fs.statSync(proxy.auditPath).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(safeProcessResult({ ok: false, exitCode: 1 }))).not.toContain(authorizationToken);
  });

  it('removes the socket, readiness, authentication, and config resources on shutdown', async () => {
    if (!proxy) throw new Error('SYNTHETIC_PROXY_NOT_RUNNING');
    const {
      process: worker,
      listenPath,
      readyPath,
      auditPath,
      temporaryDirectory,
    } = proxy;
    stopDockerLoopbackProxy(proxy);
    proxy = undefined;

    if (worker.exitCode === null && worker.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SYNTHETIC_PROXY_SHUTDOWN_TIMED_OUT')), 2_000);
        worker.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    await expectProxyEndpointClosed(listenPath);
    [readyPath, auditPath].forEach((file) => expect(fs.existsSync(file)).toBe(false));
    if (process.platform !== 'win32') expect(fs.existsSync(listenPath)).toBe(false);
    expect(fs.existsSync(temporaryDirectory)).toBe(false);
  });
});

describe('Docker endpoint normalization', () => {
  it.each([
    ['npipe:////./pipe/docker_engine', '\\\\.\\pipe\\docker_engine'],
    ['npipe://./pipe/docker_engine', '\\\\.\\pipe\\docker_engine'],
    ['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\docker_engine'],
  ])('normalizes %s', (input, expected) => {
    expect(npipePath(input)).toBe(expected);
    expect(dockerEndpoint(input)).toEqual({ socketPath: expected });
  });

  it('supports Unix sockets and TCP Docker endpoints', () => {
    expect(dockerEndpoint('unix:///var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(dockerEndpoint('tcp://127.0.0.1:2376')).toEqual({ hostname: '127.0.0.1', port: 2376 });
  });

  it.each(['ssh://docker.example.test', 'npipe://', 'malformed-endpoint'])('rejects unsupported or malformed endpoint %s', (input) => {
    expect(() => dockerEndpoint(input)).toThrow('UNSUPPORTED_DOCKER_ENDPOINT');
  });
});

describe.sequential('Docker proxy lifecycle regressions', () => {
  it('reports an immediately failed worker substantially before the startup timeout', () => {
    const startedAt = Date.now();
    expect(() => startDockerLoopbackProxy(repoRoot, {
      targetDockerHost: 'ssh://synthetic-unsupported-endpoint',
      authorizationToken,
    })).toThrow('DOCKER_PROXY_FAILED');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('makes worker shutdown idempotent and removes only its owned directory', async () => {
    const unrelatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-unrelated-'));
    const standalone = startDockerLoopbackProxy(repoRoot, {
      targetDockerHost: fakeDaemonTarget,
      authorizationToken,
    });
    let connection: net.Socket | undefined;
    try {
      fs.writeFileSync(standalone.auditPath, 'AUTH_FAILURE', { mode: 0o600 });
      connection = net.createConnection(standalone.listenPath);
      await new Promise<void>((resolve, reject) => {
        connection?.once('connect', resolve);
        connection?.once('error', reject);
      });

      stopDockerLoopbackProxy(standalone);
      stopDockerLoopbackProxy(standalone);
      connection.destroy();
      await waitForExit(standalone.process);

      await expectProxyEndpointClosed(standalone.listenPath);
      [standalone.readyPath, standalone.auditPath]
        .forEach((artifact) => expect(fs.existsSync(artifact)).toBe(false));
      if (process.platform !== 'win32') expect(fs.existsSync(standalone.listenPath)).toBe(false);
      expect(fs.existsSync(standalone.temporaryDirectory)).toBe(false);
      expect(fs.existsSync(unrelatedDirectory)).toBe(true);
      expect(() => stopDockerLoopbackProxy(standalone)).not.toThrow();
      expect(() => stopDockerLoopbackProxy(standalone)).not.toThrow();
      expect(fs.existsSync(unrelatedDirectory)).toBe(true);
    } finally {
      connection?.destroy();
      if (processExists(standalone.process.pid ?? -1)) standalone.process.kill('SIGKILL');
      removeTestPath(standalone.readyPath);
      removeTestPath(standalone.auditPath);
      if (process.platform !== 'win32') removeTestPath(standalone.listenPath);
      try {
        fs.rmdirSync(standalone.temporaryDirectory);
      } catch {
        // The worker or parent cleanup normally removed this exact directory.
      }
      try {
        fs.rmdirSync(unrelatedDirectory);
      } catch {
        // The assertion above reports any unexpected removal of this test-owned directory.
      }
    }
  });

  it('self-terminates and removes its private resources after its parent disappears', async () => {
    const moduleUrl = pathToFileURL(path.join(repoRoot, 'apps/admin-cms/src/local-development/safeSupabaseCli.ts')).href;
    const harness = spawn(process.execPath, [
      path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
      '--eval',
      `import { startDockerLoopbackProxy } from ${JSON.stringify(moduleUrl)};
const handle = startDockerLoopbackProxy(${JSON.stringify(repoRoot)}, {
  targetDockerHost: process.env.SYNTHETIC_DOCKER_TARGET,
  authorizationToken: 'synthetic-parent-liveness-authorization',
});
process.send({
  parentPid: process.pid,
  workerPid: handle.process.pid,
  listenPath: handle.listenPath,
  readyPath: handle.readyPath,
  auditPath: handle.auditPath,
  temporaryDirectory: handle.temporaryDirectory,
});
setInterval(() => {}, 1_000);`,
    ], {
      cwd: repoRoot,
      env: { ...process.env, SYNTHETIC_DOCKER_TARGET: fakeDaemonTarget },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let worker: {
      parentPid: number;
      workerPid: number;
      listenPath: string;
      readyPath: string;
      auditPath: string;
      temporaryDirectory: string;
    } | undefined;
    try {
      worker = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SYNTHETIC_PARENT_HARNESS_TIMED_OUT')), 3_000);
        harness.once('message', (message) => {
          clearTimeout(timeout);
          resolve(message as typeof worker & object);
        });
        harness.once('exit', () => {
          clearTimeout(timeout);
          reject(new Error('SYNTHETIC_PARENT_HARNESS_EXITED'));
        });
      });
      if (!worker) throw new Error('SYNTHETIC_WORKER_HANDLE_MISSING');

      process.kill(worker.parentPid, 'SIGKILL');
      await waitForExit(harness);
      await waitForCondition(() => !fs.existsSync(worker?.temporaryDirectory ?? ''));
      await waitForCondition(() => !processExists(worker?.workerPid ?? -1));

      await expectProxyEndpointClosed(worker.listenPath);
      [worker.readyPath, worker.auditPath, worker.temporaryDirectory]
        .forEach((artifact) => expect(fs.existsSync(artifact)).toBe(false));
      if (process.platform !== 'win32') expect(fs.existsSync(worker.listenPath)).toBe(false);
    } finally {
      if (harness.exitCode === null && harness.signalCode === null) harness.kill('SIGKILL');
      if (worker && processExists(worker.parentPid)) process.kill(worker.parentPid, 'SIGKILL');
      if (worker && processExists(worker.workerPid)) process.kill(worker.workerPid, 'SIGKILL');
      if (worker) {
        removeTestPath(worker.readyPath);
        removeTestPath(worker.auditPath);
        if (process.platform !== 'win32') removeTestPath(worker.listenPath);
        try {
          fs.rmdirSync(worker.temporaryDirectory);
        } catch {
          // The worker normally removes this exact private directory.
        }
      }
    }
  });
});
