import path from 'node:path';
import { runLocalSupabaseCli } from '../local-development/safeSupabaseCli';

const command = process.argv[2] as 'start' | 'stop' | 'reset' | undefined;
if (!command || !['start', 'stop', 'reset'].includes(command)) process.exit(1);

const result = runLocalSupabaseCli(command, path.resolve(__dirname, '../../../../'));
if (!result.ok) {
  console.error(`Local Supabase command failed during ${command}.`);
  process.exitCode = 1;
} else {
  console.log(`Local Supabase ${command} completed.`);
}
