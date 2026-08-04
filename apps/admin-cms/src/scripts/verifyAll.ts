import { execSync } from 'node:child_process';
import path from 'node:path';

export interface VerifyStep {
  name: string;
  command: string;
  description: string;
}

export const VERIFY_STEPS: VerifyStep[] = [
  { name: 'onboarding:check', command: 'npm run onboarding:check', description: 'Automated onboarding precheck' },
  { name: 'check:feed', command: 'npm run check:feed', description: 'Public feed contract verification' },
  { name: 'lint', command: 'npm run lint --workspace=apps/admin-cms', description: 'ESLint workspace quality check' },
  { name: 'test:admin', command: 'npm run test:admin', description: 'Vitest unit and security test suite' },
  { name: 'typecheck:admin', command: 'npm run typecheck:admin', description: 'TypeScript type check (tsc --noEmit)' },
  { name: 'build:admin', command: 'npm run build:admin', description: 'Next.js production build (next build)' },
  { name: 'git diff --check', command: 'git diff --check', description: 'Git whitespace and syntax diff check' },
];

export type CommandRunner = (cmd: string, cwd: string) => void;
export type LogFn = (msg: string) => void;

export async function runVerifyAllSteps(options?: {
  commandRunner?: CommandRunner;
  log?: LogFn;
  workdir?: string;
}): Promise<{ success: boolean; stepCount: number; failedStep?: string }> {
  const log = options?.log ?? console.log;
  const workdir = options?.workdir ?? path.resolve(__dirname, '../../../../');
  const runner =
    options?.commandRunner ??
    ((cmd, cwd) => {
      execSync(cmd, { stdio: 'inherit', cwd });
    });

  log('====================================================');
  log('STARTING FULL REPOSITORY VERIFICATION SUITE');
  log('====================================================');

  for (let i = 0; i < VERIFY_STEPS.length; i++) {
    const step = VERIFY_STEPS[i];
    log(`\n[STEP ${i + 1}/${VERIFY_STEPS.length}] ${step.name}: ${step.description}`);
    try {
      runner(step.command, workdir);
      log(`[PASS] Step ${i + 1} (${step.name}) completed cleanly.`);
    } catch {
      log('\n====================================================');
      log(`[FAIL] Verification step ${i + 1} (${step.name}) failed!`);
      log(`Description: ${step.description}`);
      log(`Command: ${step.command}`);
      log('====================================================');
      return { success: false, stepCount: i, failedStep: step.name };
    }
  }

  log('\n====================================================');
  log('FULL REPOSITORY VERIFICATION SUITE COMPLETE (PASS)');
  log('All quality gates (lint, tests, typecheck, build, diff) passed.');
  log('====================================================');

  return { success: true, stepCount: VERIFY_STEPS.length };
}

if (typeof require !== 'undefined' && require.main === module) {
  runVerifyAllSteps().then((res) => {
    if (!res.success) {
      process.exit(1);
    }
  });
}
