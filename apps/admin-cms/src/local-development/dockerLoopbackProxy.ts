import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const DOCKER_PROXY_AUTH_HEADER = 'x-capstone-docker-proxy-auth';
export const MAX_DOCKER_CREATE_BODY_BYTES = 4 * 1024 * 1024;

interface DockerPortBinding {
  HostIp?: string;
  HostIP?: string;
  HostPort?: string;
}

interface DockerCreatePayload {
  HostConfig?: {
    PortBindings?: Record<string, DockerPortBinding[] | null>;
    PublishAllPorts?: boolean;
  };
}

export function rewriteDockerCreateBody(raw: Buffer): Buffer {
  const payload = JSON.parse(raw.toString('utf8')) as DockerCreatePayload;
  if (payload.HostConfig?.PublishAllPorts === true) throw new Error('UNSAFE_DOCKER_AUTO_PUBLISH');
  const portBindings = payload.HostConfig?.PortBindings;

  if (!portBindings) return raw;

  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    const explicitBindings = bindings && bindings.length > 0
      ? bindings
      : [{ HostIp: '127.0.0.1' }];
    portBindings[containerPort] = explicitBindings;
    for (const binding of explicitBindings) {
      binding.HostIp = '127.0.0.1';
      delete binding.HostIP;
    }
  }

  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export interface DockerEndpoint {
  socketPath?: string;
  hostname?: string;
  port?: number;
}

export function npipePath(raw: string): string {
  const normalized = raw.replace(/^npipe:\/\//i, '').replaceAll('/', '\\');
  if (normalized.startsWith('\\\\.\\pipe\\')) return normalized;

  const pipeName = normalized
    .replace(/^\\+/, '')
    .replace(/^\.\\pipe\\/i, '');
  if (pipeName.length === 0) throw new Error('UNSUPPORTED_DOCKER_ENDPOINT');
  return `\\\\.\\pipe\\${pipeName}`;
}

export function dockerEndpoint(raw: string): DockerEndpoint {
  if (raw.startsWith('\\\\.\\pipe\\')) return { socketPath: npipePath(raw) };
  if (raw.startsWith('unix://')) return { socketPath: decodeURIComponent(new URL(raw).pathname) };
  if (raw.startsWith('npipe://')) return { socketPath: npipePath(raw) };

  try {
    const url = new URL(raw.replace(/^tcp:/, 'http:'));
    if (url.protocol !== 'http:') throw new Error('UNSUPPORTED_DOCKER_ENDPOINT');
    return { hostname: url.hostname, port: Number(url.port || 2375) };
  } catch {
    throw new Error('UNSUPPORTED_DOCKER_ENDPOINT');
  }
}

function upstreamOptions(endpoint: DockerEndpoint, request: http.IncomingMessage, headers: http.OutgoingHttpHeaders) {
  return {
    ...(endpoint.socketPath ? { socketPath: endpoint.socketPath } : { hostname: endpoint.hostname, port: endpoint.port }),
    method: request.method,
    path: request.url,
    headers,
  };
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isAuthorized(request: http.IncomingMessage, expectedToken: string): boolean {
  const distinctValues = request.headersDistinct[DOCKER_PROXY_AUTH_HEADER];
  const values = distinctValues ?? (() => {
    const header = request.headers[DOCKER_PROXY_AUTH_HEADER];
    return typeof header === 'string' ? [header] : header;
  })();
  if (!values || values.length === 0) return false;
  return values.every((value) => safeTokenEqual(value, expectedToken));
}

function sanitizedHeaders(request: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...request.headers };
  delete headers[DOCKER_PROXY_AUTH_HEADER];
  return headers;
}

function genericResponse(response: http.ServerResponse, statusCode: number): void {
  if (!response.headersSent) {
    response.writeHead(statusCode, {
      connection: 'close',
      'content-length': '0',
    });
  }
  response.end();
}

function forwardRequest(endpoint: DockerEndpoint, request: http.IncomingMessage, response: http.ServerResponse, body?: Buffer): void {
  const headers = sanitizedHeaders(request);
  if (body !== undefined) {
    delete headers['transfer-encoding'];
    delete headers['content-length'];
    headers['content-length'] = String(body.length);
  }

  const upstream = http.request(upstreamOptions(endpoint, request, headers), (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', () => genericResponse(response, 502));
  response.on('close', () => upstream.destroy());

  if (body !== undefined) upstream.end(body);
  else request.pipe(upstream);
}

function forwardUpgrade(endpoint: DockerEndpoint, request: http.IncomingMessage, client: Duplex, head: Buffer): void {
  const upstream = endpoint.socketPath
    ? net.createConnection(endpoint.socketPath)
    : net.createConnection(endpoint.port ?? 2375, endpoint.hostname);

  upstream.once('connect', () => {
    let rawHeaders = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      if (name.toLowerCase() === DOCKER_PROXY_AUTH_HEADER) continue;
      rawHeaders += `${name}: ${request.rawHeaders[index + 1]}\r\n`;
    }
    upstream.write(`${rawHeaders}\r\n`);
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });

  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
}

function rejectUpgrade(client: Duplex): void {
  client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

export interface DockerLoopbackProxyServerOptions {
  target: string;
  authorizationToken: string;
  maximumCreateBodyBytes?: number;
  onAuthorizationFailure?: () => void;
}

export function createDockerLoopbackProxyServer(options: DockerLoopbackProxyServerOptions): http.Server {
  const endpoint = dockerEndpoint(options.target);
  const maximumCreateBodyBytes = options.maximumCreateBodyBytes ?? MAX_DOCKER_CREATE_BODY_BYTES;
  const requestHandler = (request: http.IncomingMessage, response: http.ServerResponse) => {
    if (!isAuthorized(request, options.authorizationToken)) {
      options.onAuthorizationFailure?.();
      request.resume();
      genericResponse(response, 403);
      return;
    }

    const isContainerCreate = request.method === 'POST' && /\/containers\/create(?:\?|$)/.test(request.url ?? '');
    if (!isContainerCreate) {
      forwardRequest(endpoint, request, response);
      return;
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    let rejected = false;

    request.on('aborted', () => {
      rejected = true;
      chunks.length = 0;
    });
    request.on('error', () => {
      rejected = true;
      chunks.length = 0;
    });
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      byteLength += chunk.length;
      if (byteLength > maximumCreateBodyBytes) {
        rejected = true;
        chunks.length = 0;
        genericResponse(response, 413);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        forwardRequest(endpoint, request, response, rewriteDockerCreateBody(Buffer.concat(chunks)));
      } catch {
        genericResponse(response, 400);
      }
    });
  };
  const server = http.createServer(requestHandler);

  server.on('upgrade', (request, socket, head) => {
    if (!isAuthorized(request, options.authorizationToken)) {
      options.onAuthorizationFailure?.();
      rejectUpgrade(socket);
      return;
    }
    forwardUpgrade(endpoint, request, socket, head);
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

function removeTemporaryPath(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    // The parent process may already have removed the private marker or socket.
  }
}

function removeTemporaryDirectory(target: string): void {
  try {
    fs.rmdirSync(target);
  } catch {
    // Cleanup is best effort after this worker's known private files have been removed.
  }
}

function validParentPid(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function parentProcessExists(parentPid: number): boolean {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function ownsPrivatePaths(
  temporaryDirectory: string,
  listenPath: string,
  readyPath: string,
  auditPath: string | undefined,
): boolean {
  const resolvedDirectory = path.resolve(temporaryDirectory);
  const temporaryBase = path.resolve(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir());
  if (path.dirname(resolvedDirectory) !== temporaryBase || !path.basename(resolvedDirectory).startsWith('cip-proxy-')) {
    return false;
  }
  if (path.resolve(readyPath) !== path.join(resolvedDirectory, 'ready')) return false;
  if (auditPath && path.resolve(auditPath) !== path.join(resolvedDirectory, 'audit')) return false;
  return process.platform === 'win32' || path.resolve(listenPath) === path.join(resolvedDirectory, 'docker.sock');
}

function startProxy(): void {
  const target = process.env.CAPSTONE_DOCKER_PROXY_TARGET;
  const listenPath = process.env.CAPSTONE_DOCKER_PROXY_LISTEN;
  const readyPath = process.env.CAPSTONE_DOCKER_PROXY_READY;
  const auditPath = process.env.CAPSTONE_DOCKER_PROXY_AUDIT;
  const temporaryDirectory = process.env.CAPSTONE_DOCKER_PROXY_DIRECTORY;
  const authorizationToken = process.env.CAPSTONE_DOCKER_PROXY_AUTHORIZATION;
  const parentPid = validParentPid(process.env.CAPSTONE_DOCKER_PROXY_PARENT_PID);
  if (
    !target || !listenPath || !readyPath || !temporaryDirectory || !authorizationToken || !parentPid ||
    !ownsPrivatePaths(temporaryDirectory, listenPath, readyPath, auditPath)
  ) process.exit(1);
  delete process.env.CAPSTONE_DOCKER_PROXY_AUTHORIZATION;

  const server = createDockerLoopbackProxyServer({
    target,
    authorizationToken,
    onAuthorizationFailure: auditPath
      ? () => {
          try {
            fs.writeFileSync(auditPath, 'AUTH_FAILURE', { mode: 0o600 });
            if (process.platform !== 'win32') fs.chmodSync(auditPath, 0o600);
          } catch {
            // Authentication still fails closed if the private category-only audit cannot be written.
          }
        }
      : undefined,
  });
  let finished = false;
  let shuttingDown = false;
  const finish = (exitCode = 0) => {
    if (finished) return;
    finished = true;
    clearInterval(parentLivenessTimer);
    removeTemporaryPath(readyPath);
    if (auditPath) removeTemporaryPath(auditPath);
    if (process.platform !== 'win32') removeTemporaryPath(listenPath);
    removeTemporaryDirectory(temporaryDirectory);
    process.exit(exitCode);
  };
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => finish(exitCode));
    setTimeout(() => finish(exitCode), 1_000).unref();
  };
  const parentLivenessTimer = setInterval(() => {
    if (process.ppid !== parentPid || !parentProcessExists(parentPid)) shutdown();
  }, 250);
  parentLivenessTimer.unref();

  server.on('error', () => shutdown(1));
  if (!process.connected) {
    finish(1);
    return;
  }
  process.once('disconnect', () => shutdown());

  const listenOptions: net.ListenOptions = process.platform === 'win32'
    ? { path: listenPath, readableAll: false, writableAll: false }
    : { path: listenPath };
  server.listen(listenOptions, () => {
    try {
      if (process.platform !== 'win32') fs.chmodSync(listenPath, 0o600);
      fs.writeFileSync(readyPath, 'READY', { flag: 'wx', mode: 0o600 });
    } catch {
      shutdown(1);
    }
  });

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startProxy();
