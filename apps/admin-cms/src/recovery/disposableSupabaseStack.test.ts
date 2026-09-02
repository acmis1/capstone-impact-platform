import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightDisposablePortBase, runDisposablePsql, type DisposableStackIdentity } from './disposableSupabaseStack';
import { ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL } from './managedAuthSchemaCompatibility';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

function ownedDocker(secret: string): DisposableStackIdentity {
  const projectId = `capstone-pp1-recovery-unit-${randomBytes(4).toString('hex')}`;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-recovery-unit-'));
  directories.push(workdir);
  fs.writeFileSync(path.join(workdir, '.capstone-recovery-owner'), projectId);
  const identity = {
    projectId,
    workdir,
    networkName: `${projectId}-loopback`,
    databaseContainer: `supabase_db_${projectId}`,
    portBase: 54_940,
  };
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    if (args?.[0] === 'inspect' && args.at(-1) === identity.databaseContainer) {
      return `${projectId}|/${identity.databaseContainer}`;
    }
    if (args?.[0] === 'inspect' && args.at(-1) === `supabase_auth_${projectId}`) {
      return `${projectId}|${JSON.stringify([
        `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${secret}@db:5432/postgres`,
      ])}`;
    }
    if (args?.[0] === 'exec') return 'ALTER TABLE\n';
    throw new Error('UNEXPECTED_DOCKER_COMMAND');
  });
  return identity;
}

const allowedOptions = {
  command: ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL,
  singleTransaction: true,
  databaseUser: 'supabase_auth_admin',
} as const;

describe('disposable Auth-owner password forwarding', () => {
  it('forwards only the variable name with a restricted environment and permits the fixed SQL', () => {
    const secret = randomBytes(32).toString('hex');
    const identity = ownedDocker(secret);
    vi.stubEnv('RECOVERY_UNRELATED_PRIVATE_VALUE', randomBytes(32).toString('hex'));
    expect(runDisposablePsql(identity, allowedOptions)).toBe('ALTER TABLE\n');
    const call = vi.mocked(execFileSync).mock.calls.find((entry) => entry[1]?.[0] === 'exec');
    expect(Boolean(call)).toBe(true);
    const args = call![1] as string[];
    const options = call![2] as { env: NodeJS.ProcessEnv; stdio: string[] };
    // Never place generated credentials in an assertion's printable received/expected values.
    expect(JSON.stringify(vi.mocked(execFileSync).mock.calls.map((entry) => entry[1])).includes(secret))
      .toBe(false);
    expect(args.slice(0, 5)).toEqual(['exec', '--env', 'PGPASSWORD', identity.databaseContainer, 'psql']);
    expect(args).toContain(ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL);
    expect(options.env.PGPASSWORD === secret).toBe(true);
    expect('RECOVERY_UNRELATED_PRIVATE_VALUE' in options.env).toBe(false);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('replaces child failures with a fixed error without retaining secret-bearing output', () => {
    const secret = randomBytes(32).toString('hex');
    const identity = ownedDocker(secret);
    const inspect = vi.mocked(execFileSync).getMockImplementation()!;
    vi.mocked(execFileSync).mockImplementation((...args) => {
      if (args[1]?.[0] === 'exec') throw new Error(secret);
      return inspect(...args);
    });
    let failure: unknown;
    try {
      runDisposablePsql(identity, allowedOptions);
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error).toBe(true);
    expect(String(failure).includes(secret)).toBe(false);
    expect((failure as Error).message === 'DISPOSABLE_MANAGED_AUTH_OWNER_COMMAND_FAILED').toBe(true);
    expect((failure as Error).cause === undefined).toBe(true);
  });

  it.each([
    { command: 'SELECT 1;' },
    { command: `${ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL}\nSELECT 1;` },
    { files: ['/tmp/capstone-recovery/arbitrary.sql'] },
    { singleTransaction: false },
    { stdinSql: ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL },
  ])('refuses any relaxation of the fixed Auth-owner command contract (%#)', (change) => {
    const identity = ownedDocker(randomBytes(32).toString('hex'));
    expect(() => runDisposablePsql(identity, { ...allowedOptions, ...change }))
      .toThrowError('DISPOSABLE_MANAGED_AUTH_OWNER_COMMAND_NOT_APPROVED');
    expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.[0] === 'exec')).toBe(false);
  });

  it('requires the exact database and Auth container ownership labels before forwarding', () => {
    for (const container of ['database', 'auth']) {
      const identity = ownedDocker(randomBytes(32).toString('hex'));
      const inspect = vi.mocked(execFileSync).getMockImplementation()!;
      vi.mocked(execFileSync).mockClear().mockImplementation((...args) => {
        const target = container === 'database'
          ? identity.databaseContainer : `supabase_auth_${identity.projectId}`;
        if (args[1]?.[0] === 'inspect' && args[1].at(-1) === target) return 'wrong-owner|[]';
        return inspect(...args);
      });
      expect(() => runDisposablePsql(identity, allowedOptions)).toThrowError('OWNERSHIP_UNPROVEN');
      expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.[0] === 'exec')).toBe(false);
    }
  });
});

describe('atomic postgres SQL transport', () => {
  it('streams a batch beyond the Windows argv limit without putting SQL in argv', () => {
    const identity = ownedDocker('unused');
    const stdinSql = 'REVOKE MAINTAIN ON TABLE "public"."admin_users" FROM "anon";\n'.repeat(700);
    expect(stdinSql.length).toBeGreaterThan(32_767);
    const inspect = vi.mocked(execFileSync).getMockImplementation()!;
    vi.mocked(execFileSync).mockImplementation((...args) => {
      if (args[1]?.[0] === 'exec' && JSON.stringify(args[1]).length > 32_767) {
        throw Object.assign(new Error('spawnSync docker ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
      }
      return inspect(...args);
    });
    expect(() => runDisposablePsql(identity, { command: stdinSql, singleTransaction: true }))
      .toThrowError('ENAMETOOLONG');
    runDisposablePsql(identity, { stdinSql, singleTransaction: true });
    const call = vi.mocked(execFileSync).mock.calls.at(-1)!;
    expect(call[1]).toEqual(['exec', '-i', identity.databaseContainer, 'psql', '-U', 'postgres',
      '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '--file', '-']);
    expect(call[2]).toMatchObject({ input: stdinSql, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it.each([
    { singleTransaction: false }, { command: 'SELECT 1;' }, { files: ['/tmp/other.sql'] },
  ])('rejects non-atomic or mixed stdin execution (%#)', (change) => {
    const identity = ownedDocker('unused');
    expect(() => runDisposablePsql(identity, { stdinSql: 'SELECT 1;', singleTransaction: true, ...change }))
      .toThrowError('DISPOSABLE_PSQL_STDIN_OPTIONS_NOT_APPROVED');
    expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.[0] === 'exec')).toBe(false);
  });
});

it('rejects an entire port block on any failed bind and releases all eight accepted listeners', async () => {
  const attempted: number[] = [];
  const released: number[] = [];
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(net, 'createServer').mockImplementation(() => {
    let onError: (error: Error) => void;
    let boundPort = 0;
    const listener = {
      listening: false,
      once: (_event: string, callback: (error: Error) => void) => { onError = callback; },
      listen: (options: { host: string; port: number; exclusive: boolean }, callback: () => void) => {
        expect(options.host).toBe('127.0.0.1');
        expect(options.exclusive).toBe(true);
        attempted.push(options.port);
        if (attempted.length === 4) { onError(new Error('EACCES')); return; }
        boundPort = options.port;
        listener.listening = true;
        callback();
      },
      close: (callback: () => void) => { released.push(boundPort); listener.listening = false; callback(); },
    };
    return listener as unknown as net.Server;
  });
  const base = await preflightDisposablePortBase();
  expect(base).toBeGreaterThanOrEqual(20_040);
  expect(base).toBeLessThanOrEqual(48_040);
  expect(base).not.toBe(attempted[0]);
  expect(attempted.slice(-8)).toEqual(Array.from({ length: 8 }, (_, offset) => base + offset));
  expect(released).toEqual([...attempted.slice(0, 3), ...attempted.slice(-8)]);
  expect(output).toHaveBeenCalledExactlyOnceWith(`PREFLIGHT_PORT_BASE = ${base}\nPREFLIGHT_PORTS = ${base}-${base + 7}\nPREFLIGHT_BIND = PASS`);
});
