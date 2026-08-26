import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { deadlineFetch } from './verifyLocalSupabase';

const MAX_DIAGNOSTIC_LOG_TAIL_LENGTH = 1_000;
const MAX_CAPTURED_LOG_LENGTH = 4_000;

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
  portAvailabilityChecker?: () => Promise<boolean>;
  spawnRunner?: (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;
  processGroupKillRunner?: (pid: number, signal: NodeJS.Signals) => void;
}

function isAppPortAvailable(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(error);
      }
    });

    server.listen({ host: '127.0.0.1', port: 3000, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      });
    });
  });
}

async function waitForProcessClose(isClosed: () => boolean, timeoutMs: number): Promise<boolean> {
  const waitStart = Date.now();

  while (!isClosed() && Date.now() - waitStart < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return isClosed();
}

async function cleanupAppProcess(options: {
  childProc: ChildProcess;
  gracefulTimeoutMs: number;
  isClosed: () => boolean;
  isExited: () => boolean;
  isWin: boolean;
  processGroupKillRunner: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<string | undefined> {
  const { childProc, gracefulTimeoutMs, isClosed, isExited, isWin, processGroupKillRunner } = options;
  const pid = childProc.pid;

  if (!pid || isClosed()) return undefined;

  const terminationErrors: string[] = [];
  const signalOwnedProcess = (signal: NodeJS.Signals): void => {
    try {
      if (isWin) {
        if (!childProc.kill(signal)) {
          terminationErrors.push(`${signal} was not accepted for PID ${pid}`);
        }
      } else {
        try {
          processGroupKillRunner(-pid, signal);
        } catch {
          if (!childProc.kill(signal)) {
            terminationErrors.push(`${signal} was not accepted for PID ${pid}`);
          }
        }
      }
    } catch (error: unknown) {
      terminationErrors.push(error instanceof Error ? error.message : String(error));
    }
  };

  if (!isExited() || !isWin) {
    signalOwnedProcess('SIGTERM');
  }

  if (await waitForProcessClose(isClosed, gracefulTimeoutMs)) return undefined;

  if (!isExited() || !isWin) {
    signalOwnedProcess('SIGKILL');
  }

  if (await waitForProcessClose(isClosed, gracefulTimeoutMs)) return undefined;

  const failureContext = terminationErrors.length > 0
    ? ` (${terminationErrors.join('; ')})`
    : '';
  return `Application process cleanup failed for PID ${pid}: process streams did not close after termination${failureContext}`;
}

function appendCapturedLog(log: string, chunk: Buffer): string {
  const combined = log + chunk.toString('utf8');
  if (combined.length <= MAX_CAPTURED_LOG_LENGTH) return combined;

  const boundedTail = combined.slice(-MAX_CAPTURED_LOG_LENGTH);
  const firstLineBreak = boundedTail.match(/\r?\n/);

  // Do not retain a partial leading line: it could contain only the value portion of a secret.
  return firstLineBreak
    ? boundedTail.slice((firstLineBreak.index ?? 0) + firstLineBreak[0].length)
    : '';
}

function formatDiagnosticLogTail(label: string, capturedLog: string): string | undefined {
  if (!capturedLog) return undefined;

  const redacted = capturedLog
    .replace(/(authorization\s*[=:]\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /((?:[a-z0-9_]*?(?:key|secret|token|password|credential|authorization)[a-z0-9_]*)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .slice(-MAX_DIAGNOSTIC_LOG_TAIL_LENGTH);

  return redacted ? `${label} tail: ${redacted}` : undefined;
}

export async function runAdminAppSmokeTest(options?: AppSmokeOptions): Promise<AppSmokeResult> {
  const startTime = Date.now();
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../../');
  const appDir = path.join(repoRoot, 'apps/admin-cms');
  const readinessTimeoutMs = options?.readinessTimeoutMs ?? 60_000;
  const gracefulTimeoutMs = options?.gracefulShutdownTimeoutMs ?? 5_000;
  const httpFetch = options?.fetcher || deadlineFetch;
  const portAvailabilityChecker = options?.portAvailabilityChecker || isAppPortAvailable;
  const processGroupKillRunner = options?.processGroupKillRunner || process.kill;

  let childProc: ChildProcess | undefined;
  let processExited = false;
  let processClosed = false;
  let exitCode: number | null = null;
  let processError: Error | undefined;
  let result: AppSmokeResult | undefined;
  let cleanupError: string | undefined;
  let healthOk = false;
  let loginOk = false;

  let stdoutLog = '';
  let stderrLog = '';

  try {
    if (!(await portAvailabilityChecker())) {
      throw new Error('Port 3000 is already in use; refusing to test an unrelated application process');
    }

    const isWin = process.platform === 'win32';
    const spawnFn = options?.spawnRunner || spawn;
    const nextCliPath = require.resolve('next/dist/bin/next');

    // Own the Next.js CLI directly so Windows can terminate it through the retained child handle.
    childProc = spawnFn(process.execPath, [nextCliPath, 'dev', '--hostname', '127.0.0.1'], {
      cwd: appDir,
      detached: !isWin,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '3000' },
    });

    // Safely drain stdout/stderr streams to prevent buffer backpressure deadlocks
    childProc.stdout?.on('data', (chunk: Buffer) => {
      stdoutLog = appendCapturedLog(stdoutLog, chunk);
    });

    childProc.stderr?.on('data', (chunk: Buffer) => {
      stderrLog = appendCapturedLog(stderrLog, chunk);
    });

    childProc.on('error', (err) => {
      processError = err;
    });

    childProc.on('exit', (code) => {
      processExited = true;
      exitCode = code;
    });

    childProc.on('close', () => {
      processClosed = true;
    });

    // Readiness polling loop
    while (Date.now() - startTime < readinessTimeoutMs) {
      if (processError) {
        result = {
          success: false,
          healthOk: false,
          loginOk: false,
          errorDetail: `Next.js application failed to start: ${processError.message}`,
          durationMs: Date.now() - startTime,
        };
        break;
      }

      if (processExited) {
        const errContext = formatDiagnosticLogTail('stderr', stderrLog);
        result = {
          success: false,
          healthOk: false,
          loginOk: false,
          errorDetail: [
            `Next.js server exited early with code ${exitCode}`,
            errContext,
          ].filter((detail): detail is string => Boolean(detail)).join('. '),
          durationMs: Date.now() - startTime,
        };
        break;
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

    if (!result && (!healthOk || !loginOk)) {
      const diagnosticLogTails = [
        formatDiagnosticLogTail('stdout', stdoutLog),
        formatDiagnosticLogTail('stderr', stderrLog),
      ].filter((tail): tail is string => Boolean(tail));

      result = {
        success: false,
        healthOk,
        loginOk,
        errorDetail: [
          `Application readiness timeout (healthOk=${healthOk}, loginOk=${loginOk})`,
          ...diagnosticLogTails,
        ].join('. '),
        durationMs: Date.now() - startTime,
      };
    }

    if (!result) {
      result = {
        success: true,
        healthOk: true,
        loginOk: true,
        durationMs: Date.now() - startTime,
      };
    }
  } catch (err: unknown) {
    result = {
      success: false,
      healthOk: false,
      loginOk: false,
      errorDetail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (childProc) {
      cleanupError = await cleanupAppProcess({
        childProc,
        gracefulTimeoutMs,
        isClosed: () => processClosed,
        isExited: () => processExited,
        isWin: process.platform === 'win32',
        processGroupKillRunner,
      });
    }
  }

  if (cleanupError) {
    return {
      ...(result || {
        healthOk,
        loginOk,
        durationMs: Date.now() - startTime,
      }),
      success: false,
      errorDetail: [result?.errorDetail, cleanupError]
        .filter((detail): detail is string => Boolean(detail))
        .join('. '),
    };
  }

  return result || {
    success: false,
    healthOk,
    loginOk,
    errorDetail: 'Application smoke test ended without a result',
    durationMs: Date.now() - startTime,
  };
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
