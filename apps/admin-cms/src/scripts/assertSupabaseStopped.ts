import path from 'node:path';
import { observeLocalStack } from '../local-development/localStackState';

const repoRoot = path.resolve(__dirname, '../../../../');
const state = observeLocalStack(repoRoot);
if (state === 'STOPPED') {
  console.log('Local Supabase stack is stopped.');
} else if (state === 'RUNNING') {
  console.error('Local Supabase stack is still running.');
  process.exitCode = 1;
} else if (state === 'DEGRADED') {
  console.error('Local Supabase stack is partially running or unhealthy.');
  process.exitCode = 1;
} else {
  console.error('Local Supabase stack state could not be determined safely.');
  process.exitCode = 1;
}
