import { spawn, execSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { deadlineFetch } from './verifyLocalSupabase';

export interface AppSmokeResult {
  success: boolean;
  healthOk: boolean;
  loginOk: boolean;
  errorDetail?: string;
  durationMs?: number;
}

export interface AppSmokeOptions {
  repoRoot?: string;
  readinessTimeoutMs?: number;
  gracefulShutdownTimeoutMs?: number;
  fetcher?: (url: string) => Promise<Response>;
  spawnRunner?: (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;
}

export async function runAdminAppSmokeTest(options?: AppSmokeOptions): Promise<AppSmokeResult> {
  const startTime = Date.now();
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../../');
  const appDir = path.join(repoRoot, 'apps/admin-cms');
  const readinessTimeoutMs = options?.readinessTimeoutMs ?? 60_000;
  const gracefulTimeoutMs = options?.gracefulShutdownTimeoutMs ?? 5_000;
  const httpFetch = options?.fetcher || deadlineFetch;

  let childProc: ChildProcess | undefined;
  let processExited = false;
  let exitCode: number | null = null;
  let processError: Error | undefined;

  const stdoutLogs: string[] = [];
  const stderrLogs: string[] = [];

  try {
    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd' : 'npm';
    const spawnFn = options?.spawnRunner || spawn;

    // Start process in detached process group on POSIX to allow group signal cleanup
    childProc = spawnFn(npmCmd, ['run', 'dev'], {
      cwd: appDir,
      detached: !isWin,
      shell: isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '3000' },
    });

    // Safely drain stdout/stderr streams to prevent buffer backpressure deadlocks
    childProc.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLogs.length < 50) {
        stdoutLogs.push(chunk.toString('utf8'));
      }
    });

    childProc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLogs.length < 50) {
        stderrLogs.push(chunk.toString('utf8'));
      }
    });

    childProc.on('error', (err) => {
      processError = err;
    });

    childProc.on('exit', (code) => {
      processExited = true;
      exitCode = code;
    });

    // Readiness polling loop
    let healthOk = false;
    let loginOk = false;

    while (Date.now() - startTime < readinessTimeoutMs) {
      if (processError) {
        return {
          success: false,
          healthOk: false,
          loginOk: false,
          errorDetail: `Next.js application failed to start: ${processError.message}`,
          durationMs: Date.now() - startTime,
        };
      }

      if (processExited) {
        const errContext = stderrLogs.join('').slice(-300);
        return {
          success: false,
          healthOk: false,
          loginOk: false,
          errorDetail: `Next.js server exited early with code ${exitCode}. ${errContext}`,
          durationMs: Date.now() - startTime,
        };
      }

      if (!healthOk) {
        try {
          const res = await httpFetch('http://127.0.0.1:3000/api/health');
          if (res.status === 200) {
            healthOk = true;
          }
        } catch {
          // Keep polling
        }
      }

      if (healthOk && !loginOk) {
        try {
          const res = await httpFetch('http://127.0.0.1:3000/login');
          if (res.status === 200) {
            const body = await res.text();
            // Stable application markers
            if (body.includes('Capstone Impact') || body.includes('Sign in to Capstone Impact Platform')) {
              loginOk = true;
              break;
            }
          }
        } catch {
          // Keep polling
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!healthOk || !loginOk) {
      return {
        success: false,
        healthOk,
        loginOk,
        errorDetail: `Application readiness timeout (healthOk=${healthOk}, loginOk=${loginOk})`,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      success: true,
      healthOk: true,
      loginOk: true,
      durationMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    return {
      success: false,
      healthOk: false,
      loginOk: false,
      errorDetail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Process-tree cleanup in finally block
    if (childProc && childProc.pid && !processExited) {
      const pid = childProc.pid;
      const isWin = process.platform === 'win32';

      try {
        if (isWin) {
          // Synchronously taskkill whole tree on Windows and wait
          execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' });
        } else {
          // POSIX: Graceful SIGTERM to negative PID (process group)
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            childProc.kill('SIGTERM');
          }

          // Bounded wait for process exit
          const termStart = Date.now();
          while (!processExited && Date.now() - termStart < gracefulTimeoutMs) {
            await new Promise((r) => setTimeout(r, 100));
          }

          // Force SIGKILL fallback if process group hasn't exited
          if (!processExited) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              childProc.kill('SIGKILL');
            }
          }
        }
      } catch {
        // Ignore cleanup process kill errors
      }
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('runAppSmokeTest.ts')) {
  console.log('Running Admin/CMS application smoke test...');
  runAdminAppSmokeTest().then((res) => {
    if (res.success) {
      console.log(`✅ Admin/CMS application smoke test PASSED (/api/health 200 OK, /login 200 OK) in ${res.durationMs}ms.`);
    } else {
      console.error(`❌ Admin/CMS application smoke test FAILED: ${res.errorDetail}`);
      process.exit(1);
    }
  });
}
