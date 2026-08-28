import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const suffix = randomBytes(4).toString('hex');
const projectId = `capstone-pp1-gate4-${suffix}`;
const networkName = `${projectId}-loopback`;
const portBase = Number.parseInt(process.env.CAPSTONE_GATE4_RUNTIME_PORT_BASE ?? '54820', 10);
const DOCKER_TIMEOUT_MS = 30_000;

if (!Number.isSafeInteger(portBase) || portBase < 1024 || portBase > 65_527) {
  throw new Error('CAPSTONE_GATE4_RUNTIME_PORT_BASE_INVALID');
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DOCKER_TIMEOUT_MS,
  }).trim();
}

function configurePorts(config: string): string {
  const ports: Array<[RegExp, number]> = [
    [/^port = 54321$/m, portBase + 1],
    [/^port = 54322$/m, portBase + 2],
    [/^shadow_port = 54320$/m, portBase],
    [/^port = 54323$/m, portBase + 3],
    [/^port = 54324$/m, portBase + 4],
    [/^smtp_port = 54325$/m, portBase + 5],
    [/^pop3_port = 54326$/m, portBase + 6],
  ];
  let updated = config.replace(/^project_id = .*$/m, `project_id = "${projectId}"`);
  for (const [pattern, port] of ports) {
    const key = pattern.source.replace(/^\^/, '').split(' = ')[0];
    updated = updated.replace(pattern, `${key} = ${port}`);
  }
  return `${updated}\n[analytics]\nenabled = true\nport = ${portBase + 7}\n`;
}

function createWorkdir(): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-gate4-runtime-'));
  const destination = path.join(workdir, 'supabase');
  fs.cpSync(path.join(repositoryRoot, 'infra', 'supabase'), destination, { recursive: true });
  const configPath = path.join(destination, 'config.toml');
  fs.writeFileSync(configPath, configurePorts(fs.readFileSync(configPath, 'utf8')), 'utf8');
  return workdir;
}

function runSupabase(command: 'start' | 'stop', workdir: string, networkId: string): void {
  const proxy = startDockerLoopbackProxy(repositoryRoot);
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      ...(command === 'start' ? ['start', '--exclude', 'vector'] : ['stop', '--no-backup']),
      '--workdir', workdir,
      ...(networkId ? ['--network-id', networkId] : []),
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: command === 'start' ? 900_000 : 300_000,
      env: {
        ...process.env,
        SUPABASE_TELEMETRY_DISABLED: '1',
        DOCKER_HOST: proxy.dockerHost,
        DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(process.env.DOCKER_CUSTOM_HEADERS, proxy.authorizationToken),
      },
    });
  } finally {
    stopDockerLoopbackProxy(proxy);
  }
}

function removeOwnedDockerResidue(): void {
  const containers = docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${projectId}`])
    .split(/\r?\n/).filter(Boolean);
  if (containers.length > 0) docker(['rm', '-f', ...containers]);
  const volumes = docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${projectId}`])
    .split(/\r?\n/).filter(Boolean);
  if (volumes.length > 0) docker(['volume', 'rm', ...volumes]);
  const networks = docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}'])
    .split(/\r?\n/).filter(Boolean);
  if (networks.includes(networkName)) docker(['network', 'rm', networkName]);
}

function main(): void {
  const forwardedArguments = process.argv.slice(2);
  const workdir = createWorkdir();
  let networkId = '';
  let startAttempted = false;
  let exitCode = 1;
  try {
    networkId = docker(['network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName]);
    startAttempted = true;
    runSupabase('start', workdir, networkId);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const check = spawnSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(__dirname, 'checkGate4SchemaEvidence.ts'),
      ...forwardedArguments,
      ...(forwardedArguments.some((argument) => argument === '--expected-git-sha' || argument.startsWith('--expected-git-sha='))
        ? []
        : [`--expected-git-sha=${sha}`]),
    ], {
      cwd: repositoryRoot,
      stdio: 'inherit',
      timeout: 180_000,
      env: { ...process.env, CAPSTONE_GATE4_LOCAL_PROJECT_ID: projectId },
    });
    if (check.error) throw new Error('DISPOSABLE_GATE4_CHECK_DID_NOT_TERMINATE');
    exitCode = check.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'DISPOSABLE_GATE4_RUNTIME_FAILED');
    exitCode = 1;
  } finally {
    if (startAttempted) {
      try { runSupabase('stop', workdir, networkId); }
      catch { console.error('Disposable Gate 4 Supabase stop failed; exact-identity cleanup will continue.'); exitCode = 1; }
    }
    try { removeOwnedDockerResidue(); }
    catch { console.error('Disposable Gate 4 Docker cleanup failed.'); exitCode = 1; }
    try { fs.rmSync(workdir, { recursive: true, force: true }); }
    catch { console.error('Disposable Gate 4 workdir cleanup failed.'); exitCode = 1; }

    let residue: string[] = [];
    try {
      residue = [
        ...docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}']).split(/\r?\n/).filter(Boolean),
      ];
    } catch {
      console.error('Disposable Gate 4 residue inspection failed.');
      exitCode = 1;
    }
    if (residue.length > 0 || fs.existsSync(workdir)) {
      console.error('Disposable Gate 4 cleanup residue remains.');
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}

main();
