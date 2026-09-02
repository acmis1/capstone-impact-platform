import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';

/**
 * Disposable Supabase stacks owned entirely by the recovery rehearsal.
 *
 * Every stack gets its own project id, port block, Docker network, containers, volumes, and
 * workdir. Cleanup only ever removes resources carrying this execution own identity label, so the
 * canonical PP1 Local stack can never be stopped, reset, or deleted by a rehearsal.
 */

const DOCKER_TIMEOUT_MS = 30_000;
export const DISPOSABLE_PROJECT_PREFIX = 'capstone-pp1-recovery-';
const RECOVERY_OWNER_LABEL = 'com.capstone.recovery.project';
const OWNERSHIP_MARKER = '.capstone-recovery-owner';

/** PostgreSQL majors the pinned Supabase CLI can supply for a local restore target. */
export const SUPPORTED_RESTORE_POSTGRES_MAJORS = [15, 17] as const;

export type DisposableStackMode = 'migrated-source' | 'bare-restore-target';

export interface DisposableStackIdentity {
  projectId: string;
  networkName: string;
  portBase: number;
  workdir: string;
  databaseContainer: string;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DOCKER_TIMEOUT_MS,
  }).trim();
}

function restrictedLocalEnvironment(extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ];
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'test' };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...extra };
}

export function assertDisposableProjectId(projectId: string): void {
  if (!new RegExp(`^${DISPOSABLE_PROJECT_PREFIX}[a-z]+-[a-f0-9]{8}$`).test(projectId)) {
    throw new Error('DISPOSABLE_PROJECT_ID_UNSAFE');
  }
}

/**
 * Rewrites the reviewed Local configuration for a disposable stack.
 *
 * A bare restore target must not declare canonical buckets or a seed: everything application-owned
 * has to come back from the backup, otherwise the rehearsal would be proving the config file rather
 * than the restore.
 */
export function buildDisposableSupabaseConfig(input: {
  baseConfig: string;
  projectId: string;
  portBase: number;
  postgresMajorVersion: number;
  mode: DisposableStackMode;
}): string {
  const { baseConfig, projectId, portBase, postgresMajorVersion, mode } = input;
  if (!SUPPORTED_RESTORE_POSTGRES_MAJORS.includes(postgresMajorVersion as 15 | 17)) {
    throw new Error('RESTORE_POSTGRES_MAJOR_UNSUPPORTED');
  }
  let config = baseConfig.replace(/^project_id = .*$/m, `project_id = "${projectId}"`);
  const ports: Array<[RegExp, number]> = [
    [/^port = 54321$/m, portBase + 1],
    [/^port = 54322$/m, portBase + 2],
    [/^shadow_port = 54320$/m, portBase],
    [/^port = 54323$/m, portBase + 3],
    [/^port = 54324$/m, portBase + 4],
    [/^smtp_port = 54325$/m, portBase + 5],
    [/^pop3_port = 54326$/m, portBase + 6],
  ];
  for (const [pattern, port] of ports) {
    const key = pattern.source.replace(/^\^/, '').split(' = ')[0];
    config = config.replace(pattern, `${key} = ${port}`);
  }
  config = config.replace(/^major_version = \d+$/m, `major_version = ${postgresMajorVersion}`);

  if (mode === 'bare-restore-target') {
    config = config.replace(/^seed = \{[^}]*\}\s*$/m, '');
    config = config.replace(/^\[storage\.buckets\.[^\]]+\][\s\S]*?(?=^\[|(?![\s\S]))/gm, '');
  }
  return `${config.trimEnd()}\n\n[analytics]\nenabled = true\nport = ${portBase + 7}\n`;
}

export interface CreateDisposableStackOptions {
  repositoryRoot: string;
  mode: DisposableStackMode;
  portBase: number;
  postgresMajorVersion: number;
  /** Short lowercase tag that makes the owning phase obvious in Docker output. */
  tag: string;
}

export function createDisposableStackIdentity(
  options: CreateDisposableStackOptions,
): DisposableStackIdentity {
  if (!/^[a-z]+$/.test(options.tag)) throw new Error('DISPOSABLE_STACK_TAG_UNSAFE');
  if (!Number.isSafeInteger(options.portBase) || options.portBase < 1024 || options.portBase > 65_527) {
    throw new Error('DISPOSABLE_STACK_PORT_BASE_INVALID');
  }
  const projectId = `${DISPOSABLE_PROJECT_PREFIX}${options.tag}-${randomBytes(4).toString('hex')}`;
  assertDisposableProjectId(projectId);

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-recovery-'));
  fs.chmodSync(workdir, 0o700);
  fs.writeFileSync(path.join(workdir, OWNERSHIP_MARKER), `${projectId}\n`, { mode: 0o600 });
  const supabaseDirectory = path.join(workdir, 'supabase');
  const source = path.join(options.repositoryRoot, 'infra', 'supabase');
  fs.mkdirSync(supabaseDirectory, { recursive: true });
  fs.cpSync(path.join(source, 'templates'), path.join(supabaseDirectory, 'templates'), { recursive: true });
  if (options.mode === 'migrated-source') {
    fs.cpSync(path.join(source, 'migrations'), path.join(supabaseDirectory, 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(source, 'seed.sql'), path.join(supabaseDirectory, 'seed.sql'));
  }
  fs.writeFileSync(
    path.join(supabaseDirectory, 'config.toml'),
    buildDisposableSupabaseConfig({
      baseConfig: fs.readFileSync(path.join(source, 'config.toml'), 'utf8'),
      projectId,
      portBase: options.portBase,
      postgresMajorVersion: options.postgresMajorVersion,
      mode: options.mode,
    }),
    'utf8',
  );

  return {
    projectId,
    networkName: `${projectId}-loopback`,
    portBase: options.portBase,
    workdir,
    databaseContainer: `supabase_db_${projectId}`,
  };
}

function runSupabaseCli(
  repositoryRoot: string,
  args: string[],
  identity: DisposableStackIdentity,
  networkId: string,
  timeoutMs: number,
): void {
  const proxy = startDockerLoopbackProxy(repositoryRoot);
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      ...args,
      '--workdir', identity.workdir,
      ...(networkId ? ['--network-id', networkId] : []),
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      // Local Supabase prints its service keys on start; keep them out of rehearsal logs.
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: timeoutMs,
      env: restrictedLocalEnvironment({
        SUPABASE_TELEMETRY_DISABLED: '1',
        DOCKER_HOST: proxy.dockerHost,
        DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(
          process.env.DOCKER_CUSTOM_HEADERS,
          proxy.authorizationToken,
        ),
      }),
    });
  } finally {
    stopDockerLoopbackProxy(proxy);
  }
}

export function createDisposableNetwork(identity: DisposableStackIdentity): string {
  assertDisposableOwnership(identity);
  return docker([
    'network', 'create',
    '--driver', 'bridge',
    '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
    '--label', `${RECOVERY_OWNER_LABEL}=${identity.projectId}`,
    identity.networkName,
  ]);
}

export function startDisposableStack(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
  networkId: string,
): void {
  assertDisposableOwnership(identity);
  const startTimeout = Number.parseInt(process.env.SUPABASE_START_TIMEOUT_MS ?? '', 10);
  runSupabaseCli(
    repositoryRoot,
    ['start', '--exclude', 'vector'],
    identity,
    networkId,
    Number.isSafeInteger(startTimeout) && startTimeout > 0 ? startTimeout : 900_000,
  );
}

export function stopDisposableStack(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
  networkId: string,
): void {
  assertDisposableOwnership(identity);
  runSupabaseCli(repositoryRoot, ['stop', '--no-backup'], identity, networkId, 300_000);
}

/** Local API credentials for the disposable stack, read from the CLI rather than reconstructed. */
export function readDisposableStackEnv(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
): { apiUrl: string; serviceRoleKey: string; anonKey: string } {
  const raw = execFileSync(process.execPath, [
    path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
    'status', '--workdir', identity.workdir, '-o', 'env',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    env: restrictedLocalEnvironment({ SUPABASE_TELEMETRY_DISABLED: '1' }),
  });
  const read = (key: string): string => {
    const match = new RegExp(`^${key}="?([^"\\r\\n]+)"?$`, 'm').exec(raw);
    return match ? match[1] : '';
  };
  const apiUrl = read('API_URL');
  const serviceRoleKey = read('SERVICE_ROLE_KEY');
  const anonKey = read('ANON_KEY') || read('PUBLISHABLE_KEY');
  if (!apiUrl || !serviceRoleKey || !anonKey) throw new Error('DISPOSABLE_STACK_ENV_UNAVAILABLE');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/.test(apiUrl)) {
    throw new Error('DISPOSABLE_STACK_ENV_NOT_LOOPBACK');
  }
  return { apiUrl, serviceRoleKey, anonKey };
}

export interface DisposableResidue {
  containers: string[];
  volumes: string[];
  networks: string[];
  workdirPresent: boolean;
}

export function assertDisposableOwnership(identity: DisposableStackIdentity): void {
  assertDisposableProjectId(identity.projectId);
  if (identity.networkName !== `${identity.projectId}-loopback`
    || identity.databaseContainer !== `supabase_db_${identity.projectId}`) {
    throw new Error('DISPOSABLE_RESOURCE_IDENTITY_INVALID');
  }
  const workdir = path.resolve(identity.workdir);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, workdir);
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(workdir).startsWith('capstone-recovery-')) {
    throw new Error('DISPOSABLE_WORKDIR_PATH_UNSAFE');
  }
  if (!fs.existsSync(workdir)
    || !fs.lstatSync(workdir).isDirectory()
    || fs.lstatSync(workdir).isSymbolicLink()) {
    throw new Error('DISPOSABLE_WORKDIR_PATH_UNSAFE');
  }
  const marker = path.join(workdir, OWNERSHIP_MARKER);
  if (!fs.existsSync(marker)
    || fs.lstatSync(marker).isSymbolicLink()
    || fs.readFileSync(marker, 'utf8').trim() !== identity.projectId) {
    throw new Error('DISPOSABLE_OWNERSHIP_UNPROVEN');
  }
}

function assertDatabaseContainerOwned(identity: DisposableStackIdentity): void {
  assertDisposableOwnership(identity);
  const inspected = docker([
    'inspect', '--format', `{{ index .Config.Labels "com.supabase.cli.project" }}|{{.Name}}`,
    identity.databaseContainer,
  ]);
  if (inspected !== `${identity.projectId}|/${identity.databaseContainer}`) {
    throw new Error('DISPOSABLE_DATABASE_OWNERSHIP_UNPROVEN');
  }
}

/** Reads the verifier-owned Auth container's generated internal DB credential without logging it. */
function readDisposableAuthDatabasePassword(identity: DisposableStackIdentity): string {
  assertDisposableOwnership(identity);
  const authContainer = `supabase_auth_${identity.projectId}`;
  let inspected: string;
  try {
    inspected = docker([
      'inspect', '--format',
      `{{ index .Config.Labels "com.supabase.cli.project" }}|{{json .Config.Env}}`,
      authContainer,
    ]);
  } catch {
    throw new Error('DISPOSABLE_AUTH_DATABASE_CREDENTIAL_UNAVAILABLE');
  }
  const separator = inspected.indexOf('|');
  if (separator < 0 || inspected.slice(0, separator) !== identity.projectId) {
    throw new Error('DISPOSABLE_AUTH_CONTAINER_OWNERSHIP_UNPROVEN');
  }
  let environment: unknown;
  try {
    environment = JSON.parse(inspected.slice(separator + 1)) as unknown;
  } catch {
    throw new Error('DISPOSABLE_AUTH_DATABASE_CREDENTIAL_UNAVAILABLE');
  }
  if (!Array.isArray(environment)
    || environment.some((entry) => typeof entry !== 'string')) {
    throw new Error('DISPOSABLE_AUTH_DATABASE_CREDENTIAL_UNAVAILABLE');
  }
  const connectionEntry = environment.find((entry) => (
    entry.startsWith('GOTRUE_DB_DATABASE_URL=')
  ));
  if (!connectionEntry) throw new Error('DISPOSABLE_AUTH_DATABASE_CREDENTIAL_UNAVAILABLE');
  let connection: URL;
  try {
    connection = new URL(connectionEntry.slice('GOTRUE_DB_DATABASE_URL='.length));
  } catch {
    throw new Error('DISPOSABLE_AUTH_DATABASE_CREDENTIAL_UNAVAILABLE');
  }
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)
    || decodeURIComponent(connection.username) !== 'supabase_auth_admin'
    || !['db', identity.databaseContainer].includes(connection.hostname)
    || connection.port !== '5432'
    || connection.pathname !== '/postgres'
    || !connection.password) {
    throw new Error('DISPOSABLE_AUTH_DATABASE_CREDENTIAL_INVALID');
  }
  return decodeURIComponent(connection.password);
}

/** Only resources labelled with this execution project id are ever considered owned. */
export function inspectDisposableResidue(identity: DisposableStackIdentity): DisposableResidue {
  assertDisposableProjectId(identity.projectId);
  if (fs.existsSync(identity.workdir)) assertDisposableOwnership(identity);
  const lines = (value: string): string[] => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    containers: lines(docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${identity.projectId}`])),
    volumes: lines(docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${identity.projectId}`])),
    networks: lines(docker([
      'network', 'ls',
      '--filter', `label=${RECOVERY_OWNER_LABEL}=${identity.projectId}`,
      '--filter', `name=${identity.networkName}`,
      '--format', '{{.Name}}',
    ]))
      .filter((name) => name === identity.networkName),
    workdirPresent: fs.existsSync(identity.workdir),
  };
}

export function removeDisposableResidue(identity: DisposableStackIdentity): void {
  assertDisposableOwnership(identity);
  const residue = inspectDisposableResidue(identity);
  if (residue.containers.length > 0) docker(['rm', '-f', ...residue.containers]);
  if (residue.volumes.length > 0) docker(['volume', 'rm', ...residue.volumes]);
  if (residue.networks.length > 0) docker(['network', 'rm', ...residue.networks]);
  fs.rmSync(identity.workdir, { recursive: true, force: true });
}

export function residueIsAbsent(residue: DisposableResidue): boolean {
  return residue.containers.length === 0
    && residue.volumes.length === 0
    && residue.networks.length === 0
    && !residue.workdirPresent;
}

export interface PsqlOptions {
  files?: string[];
  command?: string;
  singleTransaction?: boolean;
  timeoutMs?: number;
  /** Fixed managed-service owner used only for reviewed compatibility SQL. */
  databaseUser?: 'postgres' | 'supabase_auth_admin';
}

const APPROVED_MANAGED_AUTH_OWNER_COMMANDS = new Set([
  `alter table auth.custom_oauth_providers
    add column if not exists custom_claims_allowlist text[] not null default '{}';`,
  `alter table auth.custom_oauth_providers
    drop column if exists custom_claims_allowlist;`,
]);

export function isApprovedDisposableManagedAuthOwnerCommand(command: unknown): boolean {
  return typeof command === 'string' && APPROVED_MANAGED_AUTH_OWNER_COMMANDS.has(command);
}

/** Runs psql inside the disposable database container only. */
export function runDisposablePsql(
  identity: DisposableStackIdentity,
  options: PsqlOptions,
): string {
  assertDatabaseContainerOwned(identity);
  const databaseUser = options.databaseUser ?? 'postgres';
  if (databaseUser === 'supabase_auth_admin'
    && (!options.singleTransaction
      || (options.files?.length ?? 0) > 0
      || !isApprovedDisposableManagedAuthOwnerCommand(options.command))) {
    throw new Error('DISPOSABLE_MANAGED_AUTH_OWNER_COMMAND_NOT_APPROVED');
  }
  const args = [
    'exec', identity.databaseContainer, 'psql',
    '-U', databaseUser,
    '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
  ];
  const environment = restrictedLocalEnvironment();
  if (databaseUser === 'supabase_auth_admin') {
    // Docker resolves this name from its restricted CLI environment; the value never enters argv.
    args.splice(1, 0, '--env', 'PGPASSWORD');
    args.push('-h', '127.0.0.1');
    environment.PGPASSWORD = readDisposableAuthDatabasePassword(identity);
  }
  if (options.singleTransaction) args.push('--single-transaction');
  if (options.command) args.push('--command', options.command);
  for (const file of options.files ?? []) args.push('--file', file);
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 600_000,
      maxBuffer: 64 * 1024 * 1024,
      env: environment,
    });
  } catch (error) {
    if (databaseUser === 'supabase_auth_admin') {
      throw new Error('DISPOSABLE_MANAGED_AUTH_OWNER_COMMAND_FAILED');
    }
    throw error;
  }
}

/** Streams a host file into the disposable container without exposing the host filesystem to it. */
export function copyFileIntoDisposableContainer(
  identity: DisposableStackIdentity,
  hostPath: string,
  containerPath: string,
): void {
  assertDatabaseContainerOwned(identity);
  if (!/^\/tmp\/capstone-recovery\/[A-Za-z0-9._-]+$/.test(containerPath)) {
    throw new Error('DISPOSABLE_CONTAINER_PATH_UNSAFE');
  }
  const hostStat = fs.lstatSync(hostPath);
  if (!hostStat.isFile() || hostStat.isSymbolicLink()) throw new Error('DISPOSABLE_HOST_ARTIFACT_INVALID');
  execFileSync('docker', ['cp', hostPath, `${identity.databaseContainer}:${containerPath}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 300_000,
  });
}

export function prepareDisposableContainerStaging(identity: DisposableStackIdentity): string {
  assertDatabaseContainerOwned(identity);
  execFileSync('docker', ['exec', '-u', 'root', identity.databaseContainer, 'rm', '-rf', '/tmp/capstone-recovery'],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  execFileSync('docker', ['exec', '-u', 'root', identity.databaseContainer, 'mkdir', '-p', '/tmp/capstone-recovery'],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  execFileSync('docker', ['exec', '-u', 'root', identity.databaseContainer, 'chmod', '700', '/tmp/capstone-recovery'],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  return '/tmp/capstone-recovery';
}
