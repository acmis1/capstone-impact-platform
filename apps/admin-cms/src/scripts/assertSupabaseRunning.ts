import path from 'node:path';
import { observeLocalStack } from '../local-development/localStackState';

const state = observeLocalStack(path.resolve(__dirname, '../../../../'));
if (state === 'RUNNING') console.log('Local Supabase stack is running.');
else if (state === 'STOPPED') {
  console.error('Local Supabase stack is stopped.');
  process.exitCode = 1;
} else if (state === 'DEGRADED') {
  console.error('Local Supabase stack is partially running or unhealthy.');
  process.exitCode = 1;
} else {
  console.error('Local Supabase stack state could not be determined safely.');
  process.exitCode = 1;
}
