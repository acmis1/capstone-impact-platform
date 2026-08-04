import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SetupStep {
  name: string;
  command: string;
  description: string;
}

export const SETUP_STEPS: SetupStep[] = [
  { name: 'onboarding:check', command: 'npm run onboarding:check', description: 'Toolchain and security precheck' },
  { name: 'supabase:start', command: 'npm run supabase:start', description: 'Start local Supabase containers' },
  { name: 'supabase:seed:buckets', command: 'npm run supabase:seed:buckets', description: 'Seed storage buckets and poster fixtures' },
  { name: 'supabase:env:local', command: 'npm run supabase:env:local', description: 'Generate local environment configuration' },
  { name: 'supabase:users:local', command: 'npm run supabase:users:local', description: 'Provision local synthetic staff accounts' },
  { name: 'supabase:verify:local', command: 'npm run supabase:verify:local', description: 'Verify local database & auth integrity' },
];

// Step index of the env:local step in SETUP_STEPS
export const SUPABASE_START_STEP_INDEX = 1;
export const ENV_LOCAL_STEP_INDEX = 3;

export type CommandRunner = (cmd: string, cwd: string) => void;
export type LogFn = (msg: string) => void;
export type ResetFailureCategory = 'DATABASE_NOT_READY' | 'DATABASE_RESTARTING' | 'DATABASE_CONNECTION_REFUSED' | 'DATABASE_CONNECTION_BUSY' | 'TRANSIENT_CONTAINER_STATE' | 'MIGRATION_FAILURE' | 'SEED_FAILURE' | 'COMMAND_NOT_FOUND' | 'COMMAND_TIMED_OUT' | 'COMMAND_TERMINATED' | 'NON_TRANSIENT_RESET_FAILURE' | 'UNKNOWN_RESET_FAILURE';
export type DatabaseReadiness = 'READY' | 'STARTING' | 'UNHEALTHY' | 'STOPPED' | 'UNKNOWN';

const TRANSIENT_RESET_FAILURES = new Set<ResetFailureCategory>(['DATABASE_NOT_READY', 'DATABASE_RESTARTING', 'DATABASE_CONNECTION_REFUSED', 'DATABASE_CONNECTION_BUSY', 'TRANSIENT_CONTAINER_STATE']);

export function classifyResetFailure(raw: string): ResetFailureCategory {
  const value = raw.toLowerCase();
  if (/migration/.test(value)) return 'MIGRATION_FAILURE';
  if (/seed/.test(value)) return 'SEED_FAILURE';
  if (/not found/.test(value)) return 'COMMAND_NOT_FOUND';
  if (/timed out|timeout/.test(value)) return 'COMMAND_TIMED_OUT';
  if (/connection refused/.test(value)) return 'DATABASE_CONNECTION_REFUSED';
  if (/connection.*busy|database.*busy/.test(value)) return 'DATABASE_CONNECTION_BUSY';
  if (/restarting/.test(value)) return 'DATABASE_RESTARTING';
  if (/not ready|starting/.test(value)) return 'DATABASE_NOT_READY';
  return 'UNKNOWN_RESET_FAILURE';
}

/** URL loopback classification — returns true only for unambiguous loopback hostnames */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    // URL.hostname for IPv6 includes brackets, e.g. '[::1]' — strip them.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Check an existing .env.local file to classify whether it points to a loopback
 * Supabase URL. Returns:
 *   'loopback'   — URL present and is localhost/127.0.0.1/::1
 *   'hosted'     — URL present but resolves to a non-loopback host
 *   'malformed'  — file exists but URL is missing or unparseable
 *   'absent'     — file does not exist
 *
 * Deliberately does NOT read the full file contents to avoid logging secrets.
 */
export function classifyEnvLocal(envPath: string): 'loopback' | 'hosted' | 'malformed' | 'absent' {
  if (!fs.existsSync(envPath)) {
    return 'absent';
  }

  let supabaseUrl: string | undefined;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('NEXT_PUBLIC_SUPABASE_URL=') || trimmed.startsWith('SUPABASE_URL=')) {
        const eqIdx = trimmed.indexOf('=');
        supabaseUrl = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  } catch {
    return 'malformed';
  }

  if (!supabaseUrl) {
    return 'malformed';
  }

  return isLoopbackUrl(supabaseUrl) ? 'loopback' : 'hosted';
}

export interface SetupResult {
  success: boolean;
  stepCount: number;
  failedStep?: string;
  cleanupAttempted: boolean;
  cleanupPassed: boolean;
}

export async function runSetupLocalSteps(options?: {
  commandRunner?: CommandRunner;
  log?: LogFn;
  workdir?: string;
  envLocalPath?: string;
}): Promise<SetupResult> {
  const log = options?.log ?? console.log;
  const workdir = options?.workdir ?? path.resolve(__dirname, '../../../../');
  const envLocalPath = options?.envLocalPath ?? path.join(workdir, 'apps/admin-cms/.env.local');
  const runner =
    options?.commandRunner ??
    ((cmd, cwd) => {
      execSync(cmd, { stdio: 'inherit', cwd });
    });

  log('====================================================');
  log('STARTING ONE-COMMAND LOCAL DEVELOPER SETUP');
  log('====================================================');

  let supabaseStarted = false;

  for (let i = 0; i < SETUP_STEPS.length; i++) {
    const step = SETUP_STEPS[i];

    // --- Environment-file safety gate (step ENV_LOCAL_STEP_INDEX) ---
    if (i === ENV_LOCAL_STEP_INDEX) {
      const classification = classifyEnvLocal(envLocalPath);
      log(`[ENV-CHECK] Local environment classification: ${classification}`);

      if (classification === 'absent') {
        // Fresh setup — generate normally (fall through to runner below).
        log('[ENV-CHECK] Generating fresh local environment configuration.');
      } else if (classification === 'loopback') {
        // Rerun after successful setup — regenerate safely (uses force-local option).
        log('[ENV-CHECK] Existing loopback configuration detected; continuing with a safe local refresh.');
        try {
          runner(`${step.command} -- --force-local`, workdir);
          log(`[PASS] Step ${i + 1} (${step.name}) completed cleanly (force-local).`);
        } catch {
          log('\n====================================================');
          log(`[FAIL] Step ${i + 1} (${step.name}) failed during loopback force-local regeneration!`);
          log('\nSafe Recovery Guidance:');
          log('Consult docs/developer-troubleshooting.md for step-by-step resolution.');
          log('====================================================');
          const cleanupResult = supabaseStarted ? attemptCleanup(runner, workdir, log) : { attempted: false, passed: false };
          return { success: false, stepCount: i, failedStep: step.name, cleanupAttempted: cleanupResult.attempted, cleanupPassed: cleanupResult.passed };
        }
        continue; // Skip the normal runner call for this step.
      } else if (classification === 'hosted') {
        // Safety refusal — never overwrite a hosted configuration.
        log('\n====================================================');
        log('[REFUSE] Existing local environment configuration appears to be non-loopback.');
        log('[REFUSE] It will NOT be overwritten to protect credentials.');
        log('[REFUSE] Inspect the configuration manually before retrying.');
        log('[REFUSE] then re-run npm run setup:local.');
        log('====================================================');
        const cleanupResult = supabaseStarted ? attemptCleanup(runner, workdir, log) : { attempted: false, passed: false };
        return { success: false, stepCount: i, failedStep: step.name + ':hosted-env-refused', cleanupAttempted: cleanupResult.attempted, cleanupPassed: cleanupResult.passed };
      } else {
        // Malformed — cannot classify safely.
        log('\n====================================================');
        log('[REFUSE] Existing local environment configuration could not be safely classified.');
        log('[REFUSE] The required local endpoint is missing or malformed.');
        log('[REFUSE] Inspect the configuration manually before retrying.');
        log('[REFUSE] then re-run npm run setup:local.');
        log('====================================================');
        const cleanupResult = supabaseStarted ? attemptCleanup(runner, workdir, log) : { attempted: false, passed: false };
        return { success: false, stepCount: i, failedStep: step.name + ':malformed-env-refused', cleanupAttempted: cleanupResult.attempted, cleanupPassed: cleanupResult.passed };
      }
    }

    log(`\n[STEP ${i + 1}/${SETUP_STEPS.length}] ${step.name}: ${step.description}`);
    try {
      runner(step.command, workdir);
      // Track that Supabase containers are running.
      if (i === SUPABASE_START_STEP_INDEX) {
        supabaseStarted = true;
      }
      log(`[PASS] Step ${i + 1} (${step.name}) completed cleanly.`);
    } catch {
      log('\n====================================================');
      log(`[FAIL] Step ${i + 1} (${step.name}) failed!`);
      log(`Description: ${step.description}`);
      log(`Command: ${step.command}`);
      log('\nSafe Recovery Guidance:');
      log('Consult docs/developer-troubleshooting.md for step-by-step resolution.');
      log('====================================================');
      const cleanupResult = supabaseStarted ? attemptCleanup(runner, workdir, log) : { attempted: false, passed: false };
      return { success: false, stepCount: i, failedStep: step.name, cleanupAttempted: cleanupResult.attempted, cleanupPassed: cleanupResult.passed };
    }
  }

  log('\n====================================================');
  log('ONE-COMMAND LOCAL DEVELOPER SETUP COMPLETE (PASS)');
  log('Local development accounts were provisioned.');
  log('Start UI server with: npm run dev:admin');
  log('====================================================');

  // Leave the stack running — the next documented action is starting the dev server.
  return { success: true, stepCount: SETUP_STEPS.length, cleanupAttempted: false, cleanupPassed: false };
}

function attemptCleanup(
  runner: CommandRunner,
  workdir: string,
  log: LogFn,
): { attempted: boolean; passed: boolean } {
  log('\n[CLEANUP] Attempting to stop local Supabase stack after failure...');
  try {
    runner('npm run supabase:stop', workdir);
    log('[CLEANUP] Stack stopped cleanly.');
    return { attempted: true, passed: true };
  } catch {
    log('[CLEANUP] Stack stop failed — containers may still be running.');
    log('[CLEANUP] Run: npm run supabase:stop  manually to clean up.');
    return { attempted: true, passed: false };
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runSetupLocalSteps().then((res) => {
    if (!res.success) {
      process.exit(1);
    }
  });
}
