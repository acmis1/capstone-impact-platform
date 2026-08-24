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

/**
 * Provisions a throwaway Supabase stack that the public deployment ledger runtime owns outright,
 * runs the runtime against it, and removes everything it created.
 *
 * The ledger runtime activates the singleton public feed head and drives irreversible forward-only
 * operations, so it must never run against a developer's canonical stack. Isolating it behind a
 * verifier-only project id, its own port block, its own Docker network and a temporary workdir is
 * what lets this production-critical writer be exercised on every CI run rather than by hand.
 */

const RUNTIME_SCRIPTS: Record<string, string> = {
  ledger: 'verifyPublicFeedLedgerRuntime.ts',
  publication: 'verifyControlledPublicationRuntime.ts',
  removal: 'verifyControlledPublicRemovalRuntime.ts',
};

const repositoryRoot = path.resolve(__dirname, '../../../..');
const portBase = Number.parseInt(process.env.CAPSTONE_LEDGER_RUNTIME_PORT_BASE ?? '54520', 10);
const suffix = randomBytes(4).toString('hex');
const projectId = `capstone-pp1-ledger-${suffix}`;
const networkName = `${projectId}-loopback`;
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const selected = requested.length > 0 ? requested : Object.keys(RUNTIME_SCRIPTS);

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-ledger-runtime-'));
  const source = path.join(repositoryRoot, 'infra', 'supabase');
  const destination = path.join(workdir, 'supabase');
  fs.cpSync(source, destination, { recursive: true });
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
      '--workdir', workdir, '--network-id', networkId,
    ], {
      cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'],
      timeout: command === 'start' ? 900_000 : 300_000,
      env: {
        ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DOCKER_HOST: proxy.dockerHost,
        DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(process.env.DOCKER_CUSTOM_HEADERS, proxy.authorizationToken),
      },
    });
  } finally {
    stopDockerLoopbackProxy(proxy);
  }
}

function main(): void {
  const workdir = createWorkdir();
  let networkId = '';
  let started = false;
  let exitCode = 1;
  try {
    networkId = docker([
      'network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName,
    ]);
    runSupabase('start', workdir, networkId);
    started = true;
    exitCode = 0;
    for (const name of selected) {
      const script = RUNTIME_SCRIPTS[name];
      if (!script) throw new Error(`Unknown disposable runtime "${name}".`);
      const runtime = spawnSync(process.execPath, [
        path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(__dirname, script),
      ], {
        cwd: path.join(repositoryRoot, 'apps', 'admin-cms'), stdio: 'inherit',
        env: {
          ...process.env,
          CAPSTONE_VERIFY_DISPOSABLE: '1',
          CAPSTONE_VERIFY_SUPABASE_WORKDIR: workdir,
          CAPSTONE_VERIFY_SUPABASE_PROJECT_ID: projectId,
        },
      });
      if (runtime.status !== 0) {
        exitCode = runtime.status ?? 1;
        break;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Disposable ledger runtime provisioning failed.');
  } finally {
    if (started && networkId) {
      try { runSupabase('stop', workdir, networkId); } catch { /* cleanup is best effort */ }
    }
    if (networkId) {
      try { docker(['network', 'rm', networkName]); } catch { /* the network may already be gone */ }
    }
    fs.rmSync(workdir, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

main();
