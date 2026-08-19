import path from 'node:path';
import {
  inspectLocalDockerNetwork,
  inspectLocalSupabasePortBindings,
  runLocalSupabaseCli,
} from '../local-development/safeSupabaseCli';
import { decideLocalSupabaseStart, observeLocalStack } from '../local-development/localStackState';

const command = process.argv[2] as 'start' | 'stop' | 'reset' | undefined;
if (!command || !['start', 'stop', 'reset'].includes(command)) process.exit(1);

const repoRoot = path.resolve(__dirname, '../../../../');
const existingStack = command === 'start' ? observeLocalStack(repoRoot) : 'STOPPED';
const startDecision = decideLocalSupabaseStart(existingStack);
const ownsCleanup = command === 'start' && startDecision.ownsCleanup;
const result = command === 'start' && startDecision.mode === 'VERIFY_EXISTING'
  ? (() => {
      const network = inspectLocalDockerNetwork();
      if (!network.ok) return { ok: false, exitCode: null, signal: null, failureCategory: network.category };
      const bindings = inspectLocalSupabasePortBindings(repoRoot, network.networkId);
      if (!bindings.ok) return { ok: false, exitCode: null, signal: null, failureCategory: bindings.category };
      return observeLocalStack(repoRoot) === 'RUNNING'
        ? { ok: true, exitCode: 0, signal: null }
        : { ok: false, exitCode: null, signal: null, failureCategory: 'STACK_NOT_READY' };
    })()
  : runLocalSupabaseCli(command, repoRoot);
if (!result.ok) {
  if (ownsCleanup) {
    const cleanup = runLocalSupabaseCli('stop', repoRoot);
    console.error(cleanup.ok ? 'Local Supabase cleanup completed.' : 'Local Supabase cleanup failed.');
  }
  console.error(`Local Supabase command failed during ${command} (${result.failureCategory ?? 'UNKNOWN'}).`);
  process.exitCode = 1;
} else {
  console.log(`Local Supabase ${command} completed.`);
}
