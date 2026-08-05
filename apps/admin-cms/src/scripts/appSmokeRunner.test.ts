import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runAdminAppSmokeTest } from './runAppSmokeTest';

function createMockChildProcess(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(proc, 'pid', { value: 12345, writable: true });
  proc.stdout = new EventEmitter() as unknown as ChildProcess['stdout'];
  proc.stderr = new EventEmitter() as unknown as ChildProcess['stderr'];
  proc.kill = vi.fn().mockReturnValue(true) as unknown as ChildProcess['kill'];
  return proc;
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
      spawnRunner: () => mockProc,
    });

    expect(result.success).toBe(true);
    expect(result.healthOk).toBe(true);
    expect(result.loginOk).toBe(true);
  });

  it('2. Returns failure when child process emits early exit', async () => {
    const mockProc = createMockChildProcess();

    const mockFetcher = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const promise = runAdminAppSmokeTest({
      readinessTimeoutMs: 2_000,
      gracefulShutdownTimeoutMs: 200,
      fetcher: mockFetcher,
      spawnRunner: () => {
        setImmediate(() => mockProc.emit('exit', 1));
        return mockProc;
      },
    });

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorDetail).toContain('Next.js server exited early with code 1');
  });

  it('3. Returns failure when login page body lacks stable application marker', async () => {
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
      spawnRunner: () => mockProc,
    });

    expect(result.success).toBe(false);
    expect(result.healthOk).toBe(true);
    expect(result.loginOk).toBe(false);
    expect(result.errorDetail).toContain('Application readiness timeout');
  });

  it('4. Returns failure when readiness polling times out', async () => {
    const mockProc = createMockChildProcess();

    const mockFetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await runAdminAppSmokeTest({
      readinessTimeoutMs: 1_200,
      gracefulShutdownTimeoutMs: 200,
      fetcher: mockFetcher,
      spawnRunner: () => mockProc,
    });

    expect(result.success).toBe(false);
    expect(result.healthOk).toBe(false);
    expect(result.loginOk).toBe(false);
    expect(result.errorDetail).toContain('Application readiness timeout');
  });
});
