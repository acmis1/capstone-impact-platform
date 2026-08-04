import { execSync, execFileSync } from 'node:child_process';
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
  { name: 'git diff --check (working tree)', command: 'git diff --check', description: 'Uncommitted working-tree whitespace check' },
  { name: 'git diff --check origin/main...HEAD (branch)', command: 'git diff --check origin/main...HEAD', description: 'Committed branch diff whitespace check against origin/main' },
];

export type CommandRunner = (cmd: string, cwd: string) => void;
export type LogFn = (msg: string) => void;

/**
 * Verify that origin/main exists in the local Git ref store.
 * Returns true if reachable, false if missing (needs git fetch origin main).
 */
export function originMainExists(workdir: string, runner?: (cmd: string) => string): boolean {
  const resolve = runner ?? ((cmd) => execFileSync('git', cmd.split(' ').slice(1), { cwd: workdir, encoding: 'utf8' }));
  try {
    resolve('git rev-parse --verify origin/main');
    return true;
  } catch {
    return false;
  }
}

export async function runVerifyAllSteps(options?: {
  commandRunner?: CommandRunner;
  log?: LogFn;
  workdir?: string;
  /** Override for testing: provides the result of originMainExists without calling git */
  originMainChecker?: (workdir: string) => boolean;
}): Promise<{ success: boolean; stepCount: number; failedStep?: string }> {
  const log = options?.log ?? console.log;
  const workdir = options?.workdir ?? path.resolve(__dirname, '../../../../');
  const runner =
    options?.commandRunner ??
    ((cmd, cwd) => {
      execSync(cmd, { stdio: 'inherit', cwd });
    });
  const checkOriginMain = options?.originMainChecker ?? ((wd) => originMainExists(wd));

  log('====================================================');
  log('STARTING FULL REPOSITORY VERIFICATION SUITE');
  log('====================================================');

  for (let i = 0; i < VERIFY_STEPS.length; i++) {
    const step = VERIFY_STEPS[i];
    log(`\n[STEP ${i + 1}/${VERIFY_STEPS.length}] ${step.name}: ${step.description}`);

    // --- Branch diff check: pre-flight for origin/main ---
    if (step.command === 'git diff --check origin/main...HEAD') {
      if (!checkOriginMain(workdir)) {
        log('\n====================================================');
        log('[FAIL] origin/main is not available in the local ref store.');
        log('Run the following command first, then retry npm run verify:all:');
        log('  git fetch origin main');
        log('====================================================');
        return { success: false, stepCount: i, failedStep: step.name };
      }
    }

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
