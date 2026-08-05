import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { deadlineFetch } from './verifyLocalSupabase';

export interface AppSmokeResult {
  success: boolean;
  healthOk: boolean;
  loginOk: boolean;
  errorDetail?: string;
}

export async function runAdminAppSmokeTest(repoRoot = path.resolve(__dirname, '../../../../')): Promise<AppSmokeResult> {
  const appDir = path.join(repoRoot, 'apps/admin-cms');
  let nextProc: ChildProcess | undefined;

  try {
    // 1. Launch Next.js dev server as a managed sub-process
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    nextProc = spawn(npmCmd, ['run', 'dev'], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '3000' },
    });

    // 2. Poll http://localhost:3000/api/health and /login with deadline fetch (up to 30s)
    let healthOk = false;
    let loginOk = false;
    const startTime = Date.now();

    while (Date.now() - startTime < 30_000) {
      if (!healthOk) {
        try {
          const fetcher = deadlineFetch;
          const res = await fetcher('http://127.0.0.1:3000/api/health');
          if (res.status === 200) {
            healthOk = true;
          }
        } catch {
          // Keep polling
        }
      }

      if (healthOk && !loginOk) {
        try {
          const fetcher = deadlineFetch;
          const res = await fetcher('http://127.0.0.1:3000/login');
          if (res.status === 200) {
            const body = await res.text();
            if (body.includes('Capstone') || body.includes('login') || body.includes('Sign in') || body.includes('input') || body.includes('<!DOCTYPE html>')) {
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
        errorDetail: `Next.js application readiness timeout (healthOk=${healthOk}, loginOk=${loginOk})`,
      };
    }

    return {
      success: true,
      healthOk: true,
      loginOk: true,
    };
  } catch (err: unknown) {
    return {
      success: false,
      healthOk: false,
      loginOk: false,
      errorDetail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // 3. Guarantee clean termination of Next.js server child process
    if (nextProc && !nextProc.killed) {
      try {
        nextProc.kill('SIGTERM');
        if (process.platform === 'win32' && nextProc.pid) {
          spawn('taskkill', ['/pid', String(nextProc.pid), '/f', '/t'], { stdio: 'ignore' });
        }
      } catch {
        // Ignore kill errors
      }
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('runAppSmokeTest.ts')) {
  console.log('Running Admin/CMS application smoke test...');
  runAdminAppSmokeTest().then((res) => {
    if (res.success) {
      console.log('✅ Admin/CMS application smoke test PASSED (/api/health 200 OK, /login 200 OK).');
    } else {
      console.error(`❌ Admin/CMS application smoke test FAILED: ${res.errorDetail}`);
      process.exit(1);
    }
  });
}
