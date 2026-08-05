import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

// --- setupLocal ---
import {
  SETUP_STEPS,
  SUPABASE_START_STEP_INDEX,
  ENV_LOCAL_STEP_INDEX,
  isLoopbackUrl,
  classifyEnvLocal,
  runSetupLocalSteps,
} from '../scripts/setupLocal';

// --- verifyAll ---
import { VERIFY_STEPS, originMainExists, runVerifyAllSteps } from '../scripts/verifyAll';

// ---------------------------------------------------------------------------
// isLoopbackUrl
// ---------------------------------------------------------------------------
describe('isLoopbackUrl', () => {
  it('returns true for localhost', () => expect(isLoopbackUrl('http://localhost:54321')).toBe(true));
  it('returns true for 127.0.0.1', () => expect(isLoopbackUrl('http://127.0.0.1:54321')).toBe(true));
  it('returns true for ::1', () => expect(isLoopbackUrl('http://[::1]:54321')).toBe(true));
  it('returns false for hosted URL', () => expect(isLoopbackUrl('https://xyz.supabase.co')).toBe(false));
  it('returns false for malformed string', () => expect(isLoopbackUrl('not-a-url')).toBe(false));
});

// ---------------------------------------------------------------------------
// classifyEnvLocal
// ---------------------------------------------------------------------------
describe('classifyEnvLocal', () => {
  it('returns absent when file does not exist', () => {
    expect(classifyEnvLocal('/nonexistent/__never__.env.local')).toBe('absent');
  });
});

// ---------------------------------------------------------------------------
// setupLocal Runner
// ---------------------------------------------------------------------------
describe('setupLocal.ts Runner', () => {
  it('0. Public configuration messages are destination-label free', async () => {
    const logs: string[] = [];
    const result = await runSetupLocalSteps({
      commandRunner: () => undefined,
      log: (message) => logs.push(message),
      workdir: '/mock/workdir',
      envLocalPath: '/nonexistent/__no__.env.local',
    });
    expect(result.success).toBe(true);
    const publicOutput = logs.join('\n');
    ['.env.local', '.local-users.json', 'apps/admin-cms', '/mock/workdir'].forEach((value) => {
      expect(publicOutput).not.toContain(value);
    });
  });

  it('1. Contains exactly 6 non-destructive local setup steps in expected order', () => {
    expect(SETUP_STEPS).toHaveLength(6);
    expect(SETUP_STEPS.map((s) => s.name)).toEqual([
      'onboarding:check',
      'supabase:start',
      'supabase:seed:buckets',
      'supabase:env:local',
      'supabase:users:local',
      'supabase:verify:local',
    ]);
    expect(SUPABASE_START_STEP_INDEX).toBe(1);
    expect(ENV_LOCAL_STEP_INDEX).toBe(3);
  });

  it('2. Fresh setup: executes all 6 steps when env.local is absent and all steps succeed', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => { executedCommands.push(cmd); };
    const mockLog = vi.fn();

    const result = await runSetupLocalSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      envLocalPath: '/nonexistent/__no__.env.local',
    });

    expect(result.success).toBe(true);
    expect(result.stepCount).toBe(6);
    // env:local step generates normally (no --force-local) because env is absent
    expect(executedCommands).toEqual([
      'npm run onboarding:check',
      'npm run supabase:start',
      'npm run supabase:seed:buckets',
      'npm run supabase:env:local',
      'npm run supabase:users:local',
      'npm run supabase:verify:local',
    ]);
    expect(result.cleanupAttempted).toBe(false);
  });

  it('3. Rerun with existing valid loopback env: uses force-local option and succeeds', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => { executedCommands.push(cmd); };
    const mockLog = vi.fn();

    // Provide a mock envLocalPath that classifyEnvLocal will see as absent (we override classify via mock path)
    // Instead: directly test using a real temp fixture — but since we cannot write files in test, we
    // spy on the classifyEnvLocal module function. Use path injection with mocked classify behavior.
    // Simplest deterministic approach: create temp in-memory env fixture via custom classify override.
    // We test by providing a custom envClassifier option — see architecture note: classifyEnvLocal is pure.
    // The runner sees the command 'npm run supabase:env:local -- --force-local' for loopback case.
    // We simulate the loopback case via a real tmpfile approach.
    const os = await import('node:os');
    const fs = await import('node:fs');
    const tmpFile = path.join(os.tmpdir(), `test-env-loopback-${Date.now()}.local`);
    fs.writeFileSync(tmpFile, 'NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321\n');

    try {
      const result = await runSetupLocalSteps({
        commandRunner: mockRunner,
        log: mockLog,
        workdir: '/mock/workdir',
        envLocalPath: tmpFile,
      });

      expect(result.success).toBe(true);
      // The env:local step uses force-local variant
      expect(executedCommands).toContain('npm run supabase:env:local -- --force-local');
      expect(executedCommands).toHaveLength(6);
      expect(mockLog.mock.calls.flat().join('\n')).not.toContain('.env.local');
      expect(mockLog.mock.calls.flat().join('\n')).toContain('safe local refresh');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('4. Hosted-looking environment: refuses without modifying and returns failure', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => { executedCommands.push(cmd); };
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);

    const os = await import('node:os');
    const fs = await import('node:fs');
    const tmpFile = path.join(os.tmpdir(), `test-env-hosted-${Date.now()}.local`);
    fs.writeFileSync(tmpFile, 'NEXT_PUBLIC_SUPABASE_URL=https://abcdefg.supabase.co\n');

    try {
      const result = await runSetupLocalSteps({
        commandRunner: mockRunner,
        log: mockLog,
        workdir: '/mock/workdir',
        envLocalPath: tmpFile,
      });

      expect(result.success).toBe(false);
      expect(result.failedStep).toContain('hosted-env-refused');
      // The env:local command must NOT have been run
      expect(executedCommands.some((c) => c.includes('supabase:env:local'))).toBe(false);
      // Refusal logged
      expect(logs.some((l) => l.includes('[REFUSE]'))).toBe(true);
      expect(logs.some((l) => l.includes('hosted'))).toBe(true);
      expect(logs.join('\n')).not.toContain('.env.local');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('5. Malformed environment: refuses without modifying and returns failure', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => { executedCommands.push(cmd); };
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);

    const os = await import('node:os');
    const fs = await import('node:fs');
    const tmpFile = path.join(os.tmpdir(), `test-env-malformed-${Date.now()}.local`);
    fs.writeFileSync(tmpFile, 'SOME_OTHER_VAR=foo\nANOTHER=bar\n'); // No SUPABASE_URL

    try {
      const result = await runSetupLocalSteps({
        commandRunner: mockRunner,
        log: mockLog,
        workdir: '/mock/workdir',
        envLocalPath: tmpFile,
      });

      expect(result.success).toBe(false);
      expect(result.failedStep).toContain('malformed-env-refused');
      expect(executedCommands.some((c) => c.includes('supabase:env:local'))).toBe(false);
      expect(logs.some((l) => l.includes('[REFUSE]'))).toBe(true);
      expect(logs.join('\n')).not.toContain('.env.local');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('6. Failure before supabase:start: no cleanup attempted', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd === 'npm run onboarding:check') {
        throw new Error('Onboarding check failed');
      }
    };
    const mockLog = vi.fn();

    const result = await runSetupLocalSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      envLocalPath: '/nonexistent/__no__.env.local',
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('onboarding:check');
    expect(result.cleanupAttempted).toBe(false);
    expect(executedCommands).toEqual(['npm run onboarding:check']);
  });

  it('7. Failure after supabase:start: cleanup (supabase:stop) is attempted', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd === 'npm run supabase:seed:buckets') {
        throw new Error('Fixture seed error');
      }
    };
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);

    const result = await runSetupLocalSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      envLocalPath: '/nonexistent/__no__.env.local',
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('supabase:seed:buckets');
    expect(result.cleanupAttempted).toBe(true);
    expect(result.cleanupPassed).toBe(true);
    expect(executedCommands).toEqual([
      'npm run onboarding:check',
      'npm run supabase:start',
      'npm run supabase:seed:buckets',
      'npm run supabase:stop',
    ]);
    expect(logs.some((l) => l.includes('[CLEANUP]'))).toBe(true);
    expect(logs.some((l) => l.includes('docs/developer-troubleshooting.md'))).toBe(true);
  });

  it('8. Cleanup failure still returns overall failure and reports cleanup failure', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd === 'npm run supabase:seed:buckets') {
        throw new Error('Seed failed');
      }
      if (cmd === 'npm run supabase:stop') {
        throw new Error('Stop failed');
      }
    };
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);

    const result = await runSetupLocalSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      envLocalPath: '/nonexistent/__no__.env.local',
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('supabase:seed:buckets');
    expect(result.cleanupAttempted).toBe(true);
    expect(result.cleanupPassed).toBe(false);
    expect(logs.some((l) => l.includes('[CLEANUP] Stack stop failed'))).toBe(true);
  });

  it('9. No step after a failed step executes', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd === 'npm run supabase:seed:buckets') {
        throw new Error('Seed failed');
      }
    };
    const mockLog = vi.fn();

    await runSetupLocalSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      envLocalPath: '/nonexistent/__no__.env.local',
    });

    // supabase:env:local, supabase:users:local, and supabase:verify:local must NOT run
    expect(executedCommands.some((c) => c.includes('supabase:env:local'))).toBe(false);
    expect(executedCommands.some((c) => c.includes('supabase:users:local'))).toBe(false);
    expect(executedCommands.some((c) => c.includes('supabase:verify:local'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyAll Runner
// ---------------------------------------------------------------------------
describe('verifyAll.ts Runner', () => {
  it('10. Contains exactly 12 quality gate verification steps', () => {
    expect(VERIFY_STEPS).toHaveLength(12);
    expect(VERIFY_STEPS.map((s) => s.name)).toEqual([
      'onboarding:check',
      'check:onboarding-docs',
      'check:terminology',
      'check:yaml',
      'check:markdown-links',
      'check:feed',
      'lint',
      'test:admin',
      'typecheck:admin',
      'build:admin',
      'git diff --check (working tree)',
      'git diff --check origin/main...HEAD (branch)',
    ]);
  });

  it('11. Executes all 12 steps sequentially when origin/main exists and all pass', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => { executedCommands.push(cmd); };
    const mockLog = vi.fn();

    const result = await runVerifyAllSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      originMainChecker: () => true, // Inject: origin/main exists
    });

    expect(result.success).toBe(true);
    expect(result.stepCount).toBe(12);
    // Last two commands must be the two diff checks
    expect(executedCommands[10]).toBe('git diff --check');
    expect(executedCommands[11]).toBe('git diff --check origin/main...HEAD');
  });

  it('12. Aborts immediately when a verification step fails (lint)', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd === 'npm run lint --workspace=apps/admin-cms') {
        throw new Error('Lint errors');
      }
    };
    const mockLog = vi.fn();

    const result = await runVerifyAllSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      originMainChecker: () => true,
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('lint');
    expect(executedCommands.some((c) => c.includes('diff --check'))).toBe(false);
  });

  it('13. Working-tree diff check failure is reported correctly', async () => {
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd === 'git diff --check') throw new Error('Whitespace errors');
    };
    const mockLog = vi.fn();

    const result = await runVerifyAllSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      originMainChecker: () => true,
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('git diff --check (working tree)');
    expect(executedCommands.some((c) => c.includes('origin/main...HEAD'))).toBe(false);
  });

  it('14. Branch diff check: when origin/main is missing, fails before running git and logs fetch guidance', async () => {
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);
    const executedCommands: string[] = [];
    const mockRunner = (cmd: string) => { executedCommands.push(cmd); };

    const result = await runVerifyAllSteps({
      commandRunner: mockRunner,
      log: mockLog,
      workdir: '/mock/workdir',
      originMainChecker: () => false, // Simulate missing origin/main
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('git diff --check origin/main...HEAD (branch)');
    // The actual git diff command must NOT have been run
    expect(executedCommands.some((c) => c.includes('origin/main...HEAD'))).toBe(false);
    // The guidance to run git fetch must appear in logs
    expect(logs.some((l) => l.includes('git fetch origin main'))).toBe(true);
  });

  it('15. originMainExists returns false when git rev-parse fails', () => {
    // Pass a runner that always throws (simulates missing ref)
    const result = originMainExists('/mock', () => { throw new Error('not found'); });
    expect(result).toBe(false);
  });

  it('16. originMainExists returns true when git rev-parse succeeds', () => {
    const result = originMainExists('/mock', () => 'eda4bd874eb7fd38136f5a45e3ede0335602e342\n');
    expect(result).toBe(true);
  });
});
