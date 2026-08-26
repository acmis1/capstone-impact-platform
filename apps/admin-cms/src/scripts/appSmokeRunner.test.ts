import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { runAdminAppSmokeTest } from './runAppSmokeTest';

function createMockChildProcess(options?: {
  closeOnKill?: boolean;
  killResult?: boolean;
}): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(proc, 'pid', { value: 12345, writable: true });
  proc.stdout = new EventEmitter() as unknown as ChildProcess['stdout'];
  proc.stderr = new EventEmitter() as unknown as ChildProcess['stderr'];
  proc.kill = vi.fn().mockImplementation((signal?: NodeJS.Signals | number) => {
    if (options?.closeOnKill !== false) {
      setImmediate(() => {
        proc.emit('exit', null, signal);
        proc.emit('close', null, signal);
      });
    }

    return options?.killResult !== false;
  }) as unknown as ChildProcess['kill'];
  return proc;
}

function createMockProcessGroupKillRunner(mockProc: ChildProcess) {
  return (_pid: number, signal: NodeJS.Signals): void => {
    mockProc.kill(signal);
  };
}

describe('runAdminAppSmokeTest Lifecycle & Readiness Unit Tests', () => {
  it('1. Returns success when /api/health and /login return HTTP 200 with stable application content', async () => {
    const mockProc = createMockChildProcess();

    const mockFetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/health')) {
        return { status: 200 } as Response;
      }
      if (url.includes('/login')) {
        return {
          status: 200,
          text: async () => '<h1>Sign in to Capstone Impact Platform</h1>',
        } as Response;
      }
      throw new Error('Unknown URL');
    });

    const result = await runAdminAppSmokeTest({
      readinessTimeoutMs: 5_000,
      gracefulShutdownTimeoutMs: 500,
      fetcher: mockFetcher,
      portAvailabilityChecker: async () => true,
      spawnRunner: () => mockProc,
      processGroupKillRunner: createMockProcessGroupKillRunner(mockProc),
    });

    expect(result.success).toBe(true);
    expect(result.healthOk).toBe(true);
    expect(result.loginOk).toBe(true);
  });

  it('2. Launches the Next.js CLI directly without a Windows shell wrapper', async () => {
    const mockProc = createMockChildProcess();
    const repoRoot = path.resolve('mock-repo');
    let spawnCall: {
      cmd: string;
      args: string[];
      opts: Record<string, unknown>;
    } | undefined;

    const result = await runAdminAppSmokeTest({
      repoRoot,
      readinessTimeoutMs: 5_000,
      gracefulShutdownTimeoutMs: 500,
      fetcher: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/health')) return { status: 200 } as Response;
        return {
          status: 200,
          text: async () => '<h1>Sign in to Capstone Impact Platform</h1>',
        } as Response;
      }),
      portAvailabilityChecker: async () => true,
      spawnRunner: (cmd, args, opts) => {
        spawnCall = { cmd, args, opts };
        return mockProc;
      },
      processGroupKillRunner: createMockProcessGroupKillRunner(mockProc),
    });

    expect(result.success).toBe(true);
    expect(spawnCall).toEqual({
      cmd: process.execPath,
      args: [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1'],
      opts: expect.objectContaining({
        cwd: path.join(repoRoot, 'apps/admin-cms'),
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({ PORT: '3000' }),
      }),
    });
  });

  it('3. Returns failure when child process emits early exit', async () => {
    const mockProc = createMockChildProcess();

    const mockFetcher = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const promise = runAdminAppSmokeTest({
      readinessTimeoutMs: 2_000,
      gracefulShutdownTimeoutMs: 200,
      fetcher: mockFetcher,
      portAvailabilityChecker: async () => true,
      spawnRunner: () => {
        setImmediate(() => {
          for (let index = 0; index < 60; index++) {
            mockProc.stderr?.emit('data', Buffer.from(`older-${index}-${'x'.repeat(80)}\n`));
          }
          mockProc.stderr?.emit('data', Buffer.from(String.raw`LATEST_EARLY_EXIT API_TOKEN=early-exit-token QUOTED_TOKEN="quoted-prefix\"QUOTED_SECRET_SUFFIX" CREDENTIAL='single-prefix\'SINGLE_SECRET_SUFFIX' Authorization: Bearer early-exit-bearer {"API_TOKEN":"token-prefix\"TOKEN_SECRET_SUFFIX","CACHE_KEY":"cache-prefix\\CACHE_SECRET_SUFFIX","SESSION_SECRET":"json-secret","password":"password-prefix\"PASSWORD_SECRET_SUFFIX","credential":"json-credential","Authorization":"Bearer json-authorization"}`));
          mockProc.emit('exit', 1);
          mockProc.emit('close', 1);
        });
        return mockProc;
      },
      processGroupKillRunner: createMockProcessGroupKillRunner(mockProc),
    });

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorDetail).toContain('Next.js server exited early with code 1');
    expect(result.errorDetail).toContain('LATEST_EARLY_EXIT');
    expect(result.errorDetail).toContain('API_TOKEN=[REDACTED]');
    expect(result.errorDetail).toContain('QUOTED_TOKEN=[REDACTED]');
    expect(result.errorDetail).toContain('CREDENTIAL=[REDACTED]');
    expect(result.errorDetail).toContain('"API_TOKEN":[REDACTED]');
    expect(result.errorDetail).toContain('"CACHE_KEY":[REDACTED]');
    expect(result.errorDetail).toContain('"SESSION_SECRET":[REDACTED]');
    expect(result.errorDetail).toContain('"password":[REDACTED]');
    expect(result.errorDetail).toContain('"credential":[REDACTED]');
    expect(result.errorDetail).toContain('"Authorization":[REDACTED]');
    expect(result.errorDetail).not.toContain('early-exit-token');
    expect(result.errorDetail).not.toContain('quoted-prefix');
    expect(result.errorDetail).not.toContain('QUOTED_SECRET_SUFFIX');
    expect(result.errorDetail).not.toContain('single-prefix');
    expect(result.errorDetail).not.toContain('SINGLE_SECRET_SUFFIX');
    expect(result.errorDetail).not.toContain('early-exit-bearer');
    expect(result.errorDetail).not.toContain('token-prefix');
    expect(result.errorDetail).not.toContain('TOKEN_SECRET_SUFFIX');
    expect(result.errorDetail).not.toContain('cache-prefix');
    expect(result.errorDetail).not.toContain('CACHE_SECRET_SUFFIX');
    expect(result.errorDetail).not.toContain('json-secret');
    expect(result.errorDetail).not.toContain('password-prefix');
    expect(result.errorDetail).not.toContain('PASSWORD_SECRET_SUFFIX');
    expect(result.errorDetail).not.toContain('json-credential');
    expect(result.errorDetail).not.toContain('json-authorization');
  });

  it('4. Returns failure when login page body lacks stable application marker', async () => {
    const mockProc = createMockChildProcess();

    const mockFetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/health')) return { status: 200 } as Response;
      if (url.includes('/login')) {
        return {
          status: 200,
          text: async () => '<html><body>Generic Error</body></html>',
        } as Response;
      }
      throw new Error('Unknown URL');
    });

    const result = await runAdminAppSmokeTest({
      readinessTimeoutMs: 1_500,
      gracefulShutdownTimeoutMs: 200,
      fetcher: mockFetcher,
      portAvailabilityChecker: async () => true,
      spawnRunner: () => mockProc,
      processGroupKillRunner: createMockProcessGroupKillRunner(mockProc),
    });

    expect(result.success).toBe(false);
    expect(result.healthOk).toBe(true);
    expect(result.loginOk).toBe(false);
    expect(result.errorDetail).toContain('Application readiness timeout');
  });

  it('5. Returns failure when readiness polling times out', async () => {
    const mockProc = createMockChildProcess();

    const mockFetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await runAdminAppSmokeTest({
      readinessTimeoutMs: 1_200,
      gracefulShutdownTimeoutMs: 200,
      fetcher: mockFetcher,
      portAvailabilityChecker: async () => true,
      spawnRunner: () => mockProc,
      processGroupKillRunner: createMockProcessGroupKillRunner(mockProc),
    });

    expect(result.success).toBe(false);
    expect(result.healthOk).toBe(false);
    expect(result.loginOk).toBe(false);
    expect(result.errorDetail).toContain('Application readiness timeout');
  });

  it('6. Includes bounded, sanitized child-process output when readiness polling times out', async () => {
    const mockProc = createMockChildProcess();
    const mockFetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await runAdminAppSmokeTest({
      readinessTimeoutMs: 1_200,
      gracefulShutdownTimeoutMs: 200,
      fetcher: mockFetcher,
      portAvailabilityChecker: async () => true,
      spawnRunner: () => {
        setImmediate(() => {
          mockProc.stdout?.emit('data', Buffer.from(`${'x'.repeat(1_100)} SENSITIVE_TOKEN=top-secret-token CACHE_KEY=cache-key-secret SESSION_SECRET=session-secret password=password-secret credential=credential-secret Bearer bearer-secret Authorization: Bearer authorization-secret`));
          mockProc.stderr?.emit('data', Buffer.from('Supabase service_role_key=service-role-secret failed to connect'));
        });
        return mockProc;
      },
      processGroupKillRunner: createMockProcessGroupKillRunner(mockProc),
    });

    expect(result.success).toBe(false);
    expect(result.errorDetail).toContain('stdout tail:');
    expect(result.errorDetail).toContain('stderr tail:');
    expect(result.errorDetail).toContain('SENSITIVE_TOKEN=[REDACTED]');
    expect(result.errorDetail).toContain('CACHE_KEY=[REDACTED]');
    expect(result.errorDetail).toContain('SESSION_SECRET=[REDACTED]');
    expect(result.errorDetail).toContain('password=[REDACTED]');
    expect(result.errorDetail).toContain('credential=[REDACTED]');
    expect(result.errorDetail).toContain('service_role_key=[REDACTED]');
    expect(result.errorDetail).not.toContain('top-secret-token');
    expect(result.errorDetail).not.toContain('cache-key-secret');
    expect(result.errorDetail).not.toContain('session-secret');
    expect(result.errorDetail).not.toContain('password-secret');
    expect(result.errorDetail).not.toContain('credential-secret');
    expect(result.errorDetail).not.toContain('bearer-secret');
    expect(result.errorDetail).not.toContain('authorization-secret');
    expect(result.errorDetail).not.toContain('service-role-secret');
  });

  it('7. Fails the smoke result when owned-process cleanup cannot be confirmed', async () => {
    const mockProc = createMockChildProcess({ closeOnKill: false, killResult: false });
    const mockFetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/health')) return { status: 200 } as Response;
      return {
        status: 200,
        text: async () => '<h1>Sign in to Capstone Impact Platform</h1>',
      } as Response;
    });

    const result = await runAdminAppSmokeTest({
      readinessTimeoutMs: 5_000,
      gracefulShutdownTimeoutMs: 10,
      fetcher: mockFetcher,
      portAvailabilityChecker: async () => true,
      spawnRunner: () => mockProc,
      processGroupKillRunner: createMockProcessGroupKillRunner(mockProc),
    });

    expect(result.success).toBe(false);
    expect(result.healthOk).toBe(true);
    expect(result.loginOk).toBe(true);
    expect(result.errorDetail).toContain('Application process cleanup failed for PID 12345');
  });

  it('8. Refuses to spawn when port 3000 is already occupied', async () => {
    const spawnRunner = vi.fn(() => createMockChildProcess());
    const fetcher = vi.fn();

    const result = await runAdminAppSmokeTest({
      fetcher,
      portAvailabilityChecker: async () => false,
      spawnRunner,
    });

    expect(result.success).toBe(false);
    expect(result.errorDetail).toContain('Port 3000 is already in use');
    expect(spawnRunner).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
