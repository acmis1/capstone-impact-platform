import { execSync } from 'node:child_process';
import path from 'node:path';

export interface SetupStep {
  name: string;
  command: string;
  description: string;
}

export const SETUP_STEPS: SetupStep[] = [
  { name: 'onboarding:check', command: 'npm run onboarding:check', description: 'Toolchain and security precheck' },
  { name: 'supabase:start', command: 'npm run supabase:start', description: 'Start local Supabase containers' },
  { name: 'supabase:reset', command: 'npm run supabase:reset', description: 'Reset local database and replay 8 migrations' },
  { name: 'supabase:seed:buckets', command: 'npm run supabase:seed:buckets', description: 'Seed storage buckets and poster fixtures' },
  { name: 'supabase:env:local', command: 'npm run supabase:env:local', description: 'Generate loopback .env.local' },
  { name: 'supabase:users:local', command: 'npm run supabase:users:local', description: 'Provision local synthetic staff accounts' },
  { name: 'supabase:verify:local', command: 'npm run supabase:verify:local', description: 'Verify local database & auth integrity' },
];

export type CommandRunner = (cmd: string, cwd: string) => void;
export type LogFn = (msg: string) => void;

export async function runSetupLocalSteps(options?: {
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
  log('STARTING ONE-COMMAND LOCAL DEVELOPER SETUP');
  log('====================================================');

  for (let i = 0; i < SETUP_STEPS.length; i++) {
    const step = SETUP_STEPS[i];
    log(`\n[STEP ${i + 1}/${SETUP_STEPS.length}] ${step.name}: ${step.description}`);
    try {
      runner(step.command, workdir);
      log(`[PASS] Step ${i + 1} (${step.name}) completed cleanly.`);
    } catch {
      log('\n====================================================');
      log(`[FAIL] Step ${i + 1} (${step.name}) failed!`);
      log(`Description: ${step.description}`);
      log(`Command: ${step.command}`);
      log('\nSafe Recovery Guidance:');
      log('Consult docs/student-troubleshooting.md for step-by-step resolution.');
      log('====================================================');
      return { success: false, stepCount: i, failedStep: step.name };
    }
  }

  log('\n====================================================');
  log('ONE-COMMAND LOCAL DEVELOPER SETUP COMPLETE (PASS)');
  log('Synthetic login credentials available in apps/admin-cms/.local-users.json');
  log('Start UI server with: npm run dev:admin');
  log('====================================================');

  return { success: true, stepCount: SETUP_STEPS.length };
}

if (typeof require !== 'undefined' && require.main === module) {
  runSetupLocalSteps().then((res) => {
    if (!res.success) {
      process.exit(1);
    }
  });
}
