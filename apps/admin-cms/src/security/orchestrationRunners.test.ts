import { describe, it, expect, vi } from 'vitest';
import { SETUP_STEPS, runSetupLocalSteps } from '../scripts/setupLocal';
import { VERIFY_STEPS, runVerifyAllSteps } from '../scripts/verifyAll';

describe('Local Developer Automation & Orchestration Runners', () => {
  describe('setupLocal.ts Runner', () => {
    it('1. Contains exactly 7 local setup steps in expected order', () => {
      expect(SETUP_STEPS).toHaveLength(7);
      expect(SETUP_STEPS.map((s) => s.name)).toEqual([
        'onboarding:check',
        'supabase:start',
        'supabase:reset',
        'supabase:seed:buckets',
        'supabase:env:local',
        'supabase:users:local',
        'supabase:verify:local',
      ]);
    });

    it('2. Executes all 7 setup steps sequentially when runner succeeds', async () => {
      const executedCommands: string[] = [];
      const mockRunner = (cmd: string) => {
        executedCommands.push(cmd);
      };
      const mockLog = vi.fn();

      const result = await runSetupLocalSteps({
        commandRunner: mockRunner,
        log: mockLog,
        workdir: '/mock/workdir',
      });

      expect(result.success).toBe(true);
      expect(result.stepCount).toBe(7);
      expect(executedCommands).toHaveLength(7);
      expect(executedCommands[0]).toBe('npm run onboarding:check');
      expect(executedCommands[6]).toBe('npm run supabase:verify:local');
    });

    it('3. Fails immediately on error, logs recovery guidance, and halts execution', async () => {
      const executedCommands: string[] = [];
      const mockRunner = (cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === 'npm run supabase:reset') {
          throw new Error('Database reset container error');
        }
      };
      const logs: string[] = [];
      const mockLog = (msg: string) => logs.push(msg);

      const result = await runSetupLocalSteps({
        commandRunner: mockRunner,
        log: mockLog,
        workdir: '/mock/workdir',
      });

      expect(result.success).toBe(false);
      expect(result.stepCount).toBe(2);
      expect(result.failedStep).toBe('supabase:reset');
      expect(executedCommands).toEqual([
        'npm run onboarding:check',
        'npm run supabase:start',
        'npm run supabase:reset',
      ]);
      expect(logs.some((l) => l.includes('docs/student-troubleshooting.md'))).toBe(true);
    });
  });

  describe('verifyAll.ts Runner', () => {
    it('4. Contains exactly 7 quality gate verification steps', () => {
      expect(VERIFY_STEPS).toHaveLength(7);
      expect(VERIFY_STEPS.map((s) => s.name)).toEqual([
        'onboarding:check',
        'check:feed',
        'lint',
        'test:admin',
        'typecheck:admin',
        'build:admin',
        'git diff --check',
      ]);
    });

    it('5. Executes all 7 quality gate steps sequentially when runner succeeds', async () => {
      const executedCommands: string[] = [];
      const mockRunner = (cmd: string) => {
        executedCommands.push(cmd);
      };
      const mockLog = vi.fn();

      const result = await runVerifyAllSteps({
        commandRunner: mockRunner,
        log: mockLog,
        workdir: '/mock/workdir',
      });

      expect(result.success).toBe(true);
      expect(result.stepCount).toBe(7);
      expect(executedCommands).toHaveLength(7);
      expect(executedCommands[0]).toBe('npm run onboarding:check');
      expect(executedCommands[6]).toBe('git diff --check');
    });

    it('6. Aborts immediately when a verification step fails', async () => {
      const executedCommands: string[] = [];
      const mockRunner = (cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === 'npm run lint --workspace=apps/admin-cms') {
          throw new Error('Lint errors found');
        }
      };
      const mockLog = vi.fn();

      const result = await runVerifyAllSteps({
        commandRunner: mockRunner,
        log: mockLog,
        workdir: '/mock/workdir',
      });

      expect(result.success).toBe(false);
      expect(result.stepCount).toBe(2);
      expect(result.failedStep).toBe('lint');
      expect(executedCommands).toEqual([
        'npm run onboarding:check',
        'npm run check:feed',
        'npm run lint --workspace=apps/admin-cms',
      ]);
    });
  });
});
