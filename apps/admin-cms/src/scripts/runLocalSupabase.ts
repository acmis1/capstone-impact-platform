import path from 'node:path';
import { runLocalSupabaseCli } from '../local-development/safeSupabaseCli';
import { observeLocalStack } from '../local-development/localStackState';

const command = process.argv[2] as 'start' | 'stop' | 'reset' | undefined;
if (!command || !['start', 'stop', 'reset'].includes(command)) process.exit(1);

const repoRoot = path.resolve(__dirname, '../../../../');
const existingStack = command === 'start' ? observeLocalStack(repoRoot) : 'STOPPED';
const result = command === 'start' && existingStack !== 'STOPPED' && existingStack !== 'UNKNOWN'
  ? { ok: true, exitCode: 0, signal: null }
  : runLocalSupabaseCli(command, repoRoot);
if (!result.ok) {
  console.error(`Local Supabase command failed during ${command}.`);
  process.exitCode = 1;
} else {
  console.log(`Local Supabase ${command} completed.`);
}
