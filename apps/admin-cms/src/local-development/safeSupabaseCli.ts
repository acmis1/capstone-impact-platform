import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DOCKER_PROXY_AUTH_HEADER } from './dockerLoopbackProxy';
import { configuredProjectId, observeLocalStack } from './localStackState';

export type LocalSupabaseCommand = 'start' | 'stop' | 'reset' | 'status';

export interface LocalSupabaseResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  failureCategory?:
    | 'COMMAND_FAILED'
    | 'SPAWN_FAILED'
    | 'COMMAND_TIMED_OUT'
    | 'COMMAND_TERMINATED'
    | 'NETWORK_INSPECTION_FAILED'
    | 'NETWORK_CREATE_FAILED'
    | 'NETWORK_INCOMPATIBLE'
    | 'DOCKER_PROXY_FAILED'
    | 'DOCKER_PROXY_AUTHENTICATION_FAILED'
    | 'DOCKER_PROXY_REQUEST_REJECTED'
    | 'DOCKER_PROXY_UPSTREAM_FAILED'
    | 'DOCKER_INSPECTION_FAILED'
    | 'MISSING_PORT_BINDING'
    | 'UNSAFE_PORT_BINDING'
    | 'WRONG_DOCKER_NETWORK'
    | 'STACK_NOT_READY';
}

export function safeProcessResult(input: { ok: boolean; exitCode?: number | null; signal?: string | null; timedOut?: boolean }): LocalSupabaseResult {
  return input.ok
    ? { ok: true, exitCode: 0, signal: null }
    : {
        ok: false,
        exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
        signal: input.signal ?? null,
        failureCategory: input.timedOut ? 'COMMAND_TIMED_OUT' : input.signal ? 'COMMAND_TERMINATED' : typeof input.exitCode === 'number' ? 'COMMAND_FAILED' : 'SPAWN_FAILED',
      };
}

export const LOCAL_DOCKER_NETWORK_NAME = 'capstone-impact-platform-local-loopback';
export const DOCKER_HOST_BINDING_OPTION = 'com.docker.network.bridge.host_binding_ipv4';
export const EXPECTED_LOCAL_PUBLISHED_PORTS = [54321, 54322, 54323, 54324, 54325, 54326, 54327] as const;

export function supabaseCommandArguments(command: LocalSupabaseCommand, networkId = LOCAL_DOCKER_NETWORK_NAME): string[] {
  const globalArguments = ['--workdir', 'infra', '--network-id', networkId];
  if (command === 'reset') return ['db', 'reset', '--local', ...globalArguments];
  if (command === 'start') return ['start', '--exclude', 'vector', ...globalArguments];
  return [command, ...globalArguments];
}

export type DockerCommandRunner = (args: string[]) => string;

function defaultDockerRunner(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export type LocalNetworkResult =
  | { ok: true; category: 'NETWORK_CREATED' | 'NETWORK_REUSED'; networkId: string }
  | { ok: false; category: 'NETWORK_INSPECTION_FAILED' | 'NETWORK_CREATE_FAILED' | 'NETWORK_INCOMPATIBLE' };

export function classifyDockerNetworkInspection(
  raw: string,
  successCategory: 'NETWORK_CREATED' | 'NETWORK_REUSED' = 'NETWORK_REUSED',
): LocalNetworkResult {
  const firstSeparator = raw.indexOf('|');
  const secondSeparator = raw.indexOf('|', firstSeparator + 1);
  const thirdSeparator = raw.indexOf('|', secondSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0 || thirdSeparator < 0) {
    return { ok: false, category: 'NETWORK_INSPECTION_FAILED' };
  }

  try {
    const networkId = JSON.parse(raw.slice(0, firstSeparator)) as unknown;
    const name = JSON.parse(raw.slice(firstSeparator + 1, secondSeparator)) as unknown;
    const driver = JSON.parse(raw.slice(secondSeparator + 1, thirdSeparator)) as unknown;
    const options = JSON.parse(raw.slice(thirdSeparator + 1)) as Record<string, unknown> | null;
    if (
      typeof networkId !== 'string' || networkId.length === 0 ||
      name !== LOCAL_DOCKER_NETWORK_NAME ||
      driver !== 'bridge' ||
      options?.[DOCKER_HOST_BINDING_OPTION] !== '127.0.0.1'
    ) {
      return { ok: false, category: 'NETWORK_INCOMPATIBLE' };
    }
    return { ok: true, category: successCategory, networkId };
  } catch {
    return { ok: false, category: 'NETWORK_INSPECTION_FAILED' };
  }
}

export function inspectLocalDockerNetwork(
  selector = LOCAL_DOCKER_NETWORK_NAME,
  runner: DockerCommandRunner = defaultDockerRunner,
  successCategory: 'NETWORK_CREATED' | 'NETWORK_REUSED' = 'NETWORK_REUSED',
): LocalNetworkResult {
  try {
    return classifyDockerNetworkInspection(
      runner([
        'network',
        'inspect',
        selector,
        '--format',
        '{{json .Id}}|{{json .Name}}|{{json .Driver}}|{{json .Options}}',
      ]),
      successCategory,
    );
  } catch {
    return { ok: false, category: 'NETWORK_INSPECTION_FAILED' };
  }
}

export function revalidateLocalDockerNetwork(
  expectedNetworkId: string,
  runner: DockerCommandRunner = defaultDockerRunner,
): LocalNetworkResult {
  const inspected = inspectLocalDockerNetwork(expectedNetworkId, runner);
  if (!inspected.ok) return inspected;
  return inspected.networkId === expectedNetworkId
    ? inspected
    : { ok: false, category: 'NETWORK_INCOMPATIBLE' };
}

export function ensureLocalDockerNetwork(runner: DockerCommandRunner = defaultDockerRunner): LocalNetworkResult {
  try {
    const names = runner(['network', 'ls', '--filter', `name=${LOCAL_DOCKER_NETWORK_NAME}`, '--format', '{{.Name}}'])
      .split(/\r?\n/)
      .filter(Boolean);
    if (names.includes(LOCAL_DOCKER_NETWORK_NAME)) return inspectLocalDockerNetwork(LOCAL_DOCKER_NETWORK_NAME, runner);
  } catch {
    return { ok: false, category: 'NETWORK_INSPECTION_FAILED' };
  }

  try {
    runner([
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      `${DOCKER_HOST_BINDING_OPTION}=127.0.0.1`,
      LOCAL_DOCKER_NETWORK_NAME,
    ]);
  } catch {
    const racedInspection = inspectLocalDockerNetwork(LOCAL_DOCKER_NETWORK_NAME, runner);
    return racedInspection.ok ? racedInspection : { ok: false, category: 'NETWORK_CREATE_FAILED' };
  }

  return inspectLocalDockerNetwork(LOCAL_DOCKER_NETWORK_NAME, runner, 'NETWORK_CREATED');
}

interface DockerPortBinding {
  HostIp?: unknown;
  HostIP?: unknown;
  HostPort?: unknown;
}

interface DockerNetworkAttachment {
  NetworkID?: unknown;
}

export type LocalPortBindingResult =
  | { ok: true; category: 'SAFE'; publishedPorts: number[] }
  | {
      ok: false;
      category: 'DOCKER_INSPECTION_FAILED' | 'MISSING_PORT_BINDING' | 'UNSAFE_PORT_BINDING' | 'WRONG_DOCKER_NETWORK';
      publishedPorts: number[];
    };

function isLoopbackHostIp(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

export function classifyDockerPortBindings(raw: string, expectedNetworkId: string): LocalPortBindingResult {
  const publishedPorts = new Set<number>();
  let sawInspection = false;

  try {
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const separator = line.indexOf('|');
      if (separator < 0) return { ok: false, category: 'DOCKER_INSPECTION_FAILED', publishedPorts: [] };
      const ports = JSON.parse(line.slice(0, separator)) as Record<string, DockerPortBinding[] | null> | null;
      const networks = JSON.parse(line.slice(separator + 1)) as Record<string, DockerNetworkAttachment | null> | null;
      sawInspection = true;

      if (!networks || !Object.values(networks).some((attachment) => attachment?.NetworkID === expectedNetworkId)) {
        return { ok: false, category: 'WRONG_DOCKER_NETWORK', publishedPorts: [...publishedPorts].sort((a, b) => a - b) };
      }

      for (const bindings of Object.values(ports ?? {})) {
        for (const binding of bindings ?? []) {
          const hostPort = typeof binding.HostPort === 'string' && /^\d{1,5}$/.test(binding.HostPort)
            ? Number(binding.HostPort)
            : NaN;
          if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
            return { ok: false, category: 'DOCKER_INSPECTION_FAILED', publishedPorts: [...publishedPorts].sort((a, b) => a - b) };
          }
          publishedPorts.add(hostPort);
          if (!isLoopbackHostIp(binding.HostIp ?? binding.HostIP)) {
            return { ok: false, category: 'UNSAFE_PORT_BINDING', publishedPorts: [...publishedPorts].sort((a, b) => a - b) };
          }
        }
      }
    }
  } catch {
    return { ok: false, category: 'DOCKER_INSPECTION_FAILED', publishedPorts: [] };
  }

  const sortedPorts = [...publishedPorts].sort((a, b) => a - b);
  if (!sawInspection || EXPECTED_LOCAL_PUBLISHED_PORTS.some((port) => !publishedPorts.has(port))) {
    return { ok: false, category: 'MISSING_PORT_BINDING', publishedPorts: sortedPorts };
  }
  return { ok: true, category: 'SAFE', publishedPorts: sortedPorts };
}

export function inspectLocalSupabasePortBindings(
  repoRoot: string,
  expectedNetworkId: string,
  runner: DockerCommandRunner = defaultDockerRunner,
): LocalPortBindingResult {
  const projectId = configuredProjectId(repoRoot);
  if (!projectId) return { ok: false, category: 'DOCKER_INSPECTION_FAILED', publishedPorts: [] };

  try {
    const rows = runner([
      'ps',
      '--filter',
      `label=com.supabase.cli.project=${projectId}`,
      '--format',
      '{{.ID}}',
    ]).split(/\r?\n/).filter(Boolean);
    if (rows.length === 0) return { ok: false, category: 'MISSING_PORT_BINDING', publishedPorts: [] };
    const raw = runner([
      'inspect',
      '--format',
      '{{json .NetworkSettings.Ports}}|{{json .NetworkSettings.Networks}}',
      ...rows,
    ]);
    return classifyDockerPortBindings(raw, expectedNetworkId);
  } catch {
    return { ok: false, category: 'DOCKER_INSPECTION_FAILED', publishedPorts: [] };
  }
}

interface DockerProxyPrivatePaths {
  listenPath: string;
  readyPath: string;
  auditPath: string;
  temporaryDirectory: string;
}

export interface DockerProxyHandle extends DockerProxyPrivatePaths {
  process: ChildProcess;
  dockerHost: string;
  authorizationToken: string;
}

function waitBriefly(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function childProcessIsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }

  if (process.platform === 'win32') return true;
  const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.error) return true;
  const state = probe.stdout.trim();
  if (probe.status === 1 && state.length === 0) return false;
  return probe.status !== 0 || (state.length > 0 && !state.startsWith('Z'));
}

function removeTemporaryPath(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    // The worker may already have removed its private temporary socket or marker.
  }
}

function removeTemporaryDirectory(target: string): void {
  try {
    fs.rmdirSync(target);
  } catch {
    // Cleanup is best effort after the known private files have been removed.
  }
}

function resolveDockerHost(): string {
  if (process.env.DOCKER_HOST?.trim()) return process.env.DOCKER_HOST.trim();
  const raw = defaultDockerRunner(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']).trim();
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'string' || parsed.length === 0) throw new Error('DOCKER_HOST_UNAVAILABLE');
  return parsed;
}

export function dockerProxyCustomHeaders(existing: string | undefined, authorizationToken: string): string {
  const authPrefix = `${DOCKER_PROXY_AUTH_HEADER.toLowerCase()}=`;
  const preserved = (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.toLowerCase().startsWith(authPrefix));
  preserved.push(`${DOCKER_PROXY_AUTH_HEADER}=${authorizationToken}`);
  return preserved.join(',');
}

function proxyPermissionsAreSafe(
  temporaryDirectory: string,
  listenPath: string,
  readyPath: string,
): boolean {
  if (process.platform === 'win32') {
    return fs.statSync(temporaryDirectory).isDirectory() && fs.statSync(readyPath).isFile();
  }
  if ((fs.statSync(temporaryDirectory).mode & 0o777) !== 0o700) return false;
  if ((fs.statSync(readyPath).mode & 0o777) !== 0o600) return false;
  return (fs.statSync(listenPath).mode & 0o777) === 0o600;
}

function cleanupDockerProxyPaths(paths: DockerProxyPrivatePaths): void {
  removeTemporaryPath(paths.readyPath);
  removeTemporaryPath(paths.auditPath);
  if (process.platform !== 'win32') removeTemporaryPath(paths.listenPath);
  removeTemporaryDirectory(paths.temporaryDirectory);
}

const proxyShutdownRequests = new WeakSet<ChildProcess>();

function requestDockerProxyShutdown(child: ChildProcess): void {
  if (proxyShutdownRequests.has(child)) return;
  proxyShutdownRequests.add(child);
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (child.connected) child.disconnect();
    else child.kill('SIGTERM');
  } catch {
    // The worker may already have exited or disconnected.
  }

  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1_500).unref();
}

export function startDockerLoopbackProxy(
  repoRoot: string,
  options?: { targetDockerHost?: string; authorizationToken?: string },
): DockerProxyHandle {
  const targetDockerHost = options?.targetDockerHost ?? resolveDockerHost();
  const authorizationToken = options?.authorizationToken ?? randomBytes(32).toString('base64url');
  if (authorizationToken.length === 0) throw new Error('DOCKER_PROXY_FAILED');
  const temporaryBase = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = fs.mkdtempSync(path.join(temporaryBase, 'cip-proxy-'));
    if (process.platform !== 'win32') fs.chmodSync(temporaryDirectory, 0o700);
  } catch {
    if (temporaryDirectory) removeTemporaryDirectory(temporaryDirectory);
    throw new Error('DOCKER_PROXY_FAILED');
  }
  const pipeName = `capstone-impact-docker-${randomBytes(16).toString('hex')}`;
  const listenPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : path.join(temporaryDirectory, 'docker.sock');
  const dockerHost = process.platform === 'win32'
    ? `npipe:////./pipe/${pipeName}`
    : `unix://${listenPath}`;
  const readyPath = path.join(temporaryDirectory, 'ready');
  const auditPath = path.join(temporaryDirectory, 'audit');
  const privatePaths: DockerProxyPrivatePaths = {
    listenPath,
    readyPath,
    auditPath,
    temporaryDirectory,
  };
  const workerPath = path.join(repoRoot, 'apps/admin-cms/src/local-development/dockerLoopbackProxy.ts');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [workerPath], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: process.platform === 'win32',
      env: {
        ...process.env,
        CAPSTONE_DOCKER_PROXY_TARGET: targetDockerHost,
        CAPSTONE_DOCKER_PROXY_LISTEN: listenPath,
        CAPSTONE_DOCKER_PROXY_READY: readyPath,
        CAPSTONE_DOCKER_PROXY_AUDIT: auditPath,
        CAPSTONE_DOCKER_PROXY_DIRECTORY: temporaryDirectory,
        CAPSTONE_DOCKER_PROXY_PARENT_PID: String(process.pid),
        CAPSTONE_DOCKER_PROXY_AUTHORIZATION: authorizationToken,
      },
    });
    child.unref();
    child.channel?.unref();
  } catch {
    cleanupDockerProxyPaths(privatePaths);
    throw new Error('DOCKER_PROXY_FAILED');
  }
  let spawnFailed = false;
  child.once('error', () => {
    spawnFailed = true;
  });

  for (let elapsed = 0; elapsed < 5_000; elapsed += 25) {
    if (fs.existsSync(readyPath)) {
      const handle = {
        process: child,
        dockerHost,
        ...privatePaths,
        authorizationToken,
      };
      try {
        if (proxyPermissionsAreSafe(temporaryDirectory, listenPath, readyPath)) return handle;
      } catch {
        // A missing or ambiguous endpoint is not ready for use.
      }
      requestDockerProxyShutdown(child);
      cleanupDockerProxyPaths(handle);
      throw new Error('DOCKER_PROXY_FAILED');
    }
    if (spawnFailed || child.exitCode !== null || !childProcessIsAlive(child.pid)) break;
    waitBriefly(25);
  }

  requestDockerProxyShutdown(child);
  cleanupDockerProxyPaths(privatePaths);
  throw new Error('DOCKER_PROXY_FAILED');
}

export function stopDockerLoopbackProxy(handle: DockerProxyHandle): void {
  requestDockerProxyShutdown(handle.process);
  cleanupDockerProxyPaths(handle);
}

const envStartTimeout = process.env.SUPABASE_START_TIMEOUT_MS ? parseInt(process.env.SUPABASE_START_TIMEOUT_MS, 10) : undefined;

export const commandTimeoutMs: Record<LocalSupabaseCommand, number> = {
  start: envStartTimeout && !isNaN(envStartTimeout) ? envStartTimeout : 120_000,
  stop: 60_000,
  reset: 180_000,
  status: 15_000,
};

function proxyFailureCategory(error: unknown): LocalSupabaseResult['failureCategory'] | undefined {
  const child = error as { stdout?: unknown; stderr?: unknown };
  const diagnostics = [child.stdout, child.stderr]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '')
    .join('\n');
  if (/\b403\b|forbidden/i.test(diagnostics)) return 'DOCKER_PROXY_AUTHENTICATION_FAILED';
  if (/\b(?:400|413)\b|bad request|payload too large/i.test(diagnostics)) return 'DOCKER_PROXY_REQUEST_REJECTED';
  if (/\b502\b|bad gateway/i.test(diagnostics)) return 'DOCKER_PROXY_UPSTREAM_FAILED';
  return undefined;
}

function auditedProxyAuthenticationFailure(auditPath: string): LocalSupabaseResult['failureCategory'] | undefined {
  try {
    if (fs.readFileSync(auditPath, 'utf8') === 'AUTH_FAILURE') return 'DOCKER_PROXY_AUTHENTICATION_FAILED';
  } catch {
    // Fall back to the sanitized CLI response category when no audit marker exists.
  }
  return undefined;
}

export function runLocalSupabaseCli(command: LocalSupabaseCommand, repoRoot: string): LocalSupabaseResult {
  let proxy: DockerProxyHandle | undefined;
  let networkId: string | undefined;
  try {
    if (command === 'start' || command === 'reset') {
      const network = ensureLocalDockerNetwork();
      if (!network.ok) return { ok: false, exitCode: null, signal: null, failureCategory: network.category };
      networkId = network.networkId;
      try {
        proxy = startDockerLoopbackProxy(repoRoot);
      } catch {
        return { ok: false, exitCode: null, signal: null, failureCategory: 'DOCKER_PROXY_FAILED' };
      }
    }

    const cliShim = path.join(repoRoot, 'node_modules', 'supabase', 'dist', 'supabase.js');
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      SUPABASE_TELEMETRY_DISABLED: '1',
      ...(proxy
        ? {
            DOCKER_HOST: proxy.dockerHost,
            DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(process.env.DOCKER_CUSTOM_HEADERS, proxy.authorizationToken),
          }
        : {}),
    };
    delete childEnvironment.CAPSTONE_DOCKER_PROXY_AUTHORIZATION;
    delete childEnvironment.CAPSTONE_DOCKER_PROXY_AUDIT;
    delete childEnvironment.CAPSTONE_DOCKER_PROXY_DIRECTORY;
    delete childEnvironment.CAPSTONE_DOCKER_PROXY_LISTEN;
    delete childEnvironment.CAPSTONE_DOCKER_PROXY_PARENT_PID;
    delete childEnvironment.CAPSTONE_DOCKER_PROXY_READY;
    delete childEnvironment.CAPSTONE_DOCKER_PROXY_TARGET;

    if (networkId) {
      const currentNetwork = revalidateLocalDockerNetwork(networkId);
      if (!currentNetwork.ok) {
        return { ok: false, exitCode: null, signal: null, failureCategory: currentNetwork.category };
      }
    }

    const output = execFileSync(process.execPath, [cliShim, ...supabaseCommandArguments(command, networkId)], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: commandTimeoutMs[command],
      killSignal: 'SIGTERM',
      env: childEnvironment,
    });
    void output;

    if (command === 'start' || command === 'reset') {
      if (!networkId) return { ok: false, exitCode: 0, signal: null, failureCategory: 'NETWORK_INSPECTION_FAILED' };
      const currentNetwork = revalidateLocalDockerNetwork(networkId);
      if (!currentNetwork.ok) {
        return { ok: false, exitCode: 0, signal: null, failureCategory: currentNetwork.category };
      }
      const bindings = inspectLocalSupabasePortBindings(repoRoot, networkId);
      if (!bindings.ok) {
        return { ok: false, exitCode: 0, signal: null, failureCategory: bindings.category };
      }
      if (observeLocalStack(repoRoot) !== 'RUNNING') {
        return { ok: false, exitCode: 0, signal: null, failureCategory: 'STACK_NOT_READY' };
      }
    }
    return safeProcessResult({ ok: true });
  } catch (error: unknown) {
    const child = error as { status?: number | null; signal?: string | null; stdout?: unknown; stderr?: unknown };
    const proxyCategory = proxy
      ? auditedProxyAuthenticationFailure(proxy.auditPath) ?? proxyFailureCategory(error)
      : undefined;
    if (proxyCategory) return { ok: false, exitCode: child.status ?? null, signal: child.signal ?? null, failureCategory: proxyCategory };
    return safeProcessResult({ ok: false, exitCode: child.status, signal: child.signal, timedOut: Boolean((child as { killed?: boolean }).killed) });
  } finally {
    if (proxy) stopDockerLoopbackProxy(proxy);
  }
}
