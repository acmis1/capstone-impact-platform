import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDisposablePsql, type DisposableStackIdentity } from './disposableSupabaseStack';
import { ADD_CUSTOM_CLAIMS_ALLOWLIST_SQL } from './managedAuthSchemaCompatibility';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const directories: string[] = [];

afterEach(() => {
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
