import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { AssistiveValidationCoordinator } from '../assistive-validation/services/assistiveCoordinator';
import { getAssistiveWorkerHealth } from '../assistive-validation/services/assistiveJobService';
import { PythonAssistiveWorkerProcess } from '../assistive-validation/services/pythonWorkerProcess';
import { SupabaseAssistiveJobRepository } from '../assistive-validation/repositories/assistiveJobRepository';
import { SupabaseAssistiveInputRepository } from '../assistive-validation/repositories/assistiveInputRepository';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const allowedModes = new Set(['--once', '--loop', '--health']);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !allowedModes.has(args[0]))) {
  console.error('Usage: runAssistiveCoordinator.ts [--once|--loop|--health]');
  process.exitCode = 2;
} else {
  const mode = args[0] ?? '--once';
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const local = parseSupabaseCliEnv(execSync(
    `"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`,
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ));
  if (!local.API_URL || !local.SERVICE_ROLE_KEY || !isLoopbackUrl(local.API_URL)) {
    throw new Error('Assistive coordinator requires loopback Local Supabase.');
  }
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const jobs = new SupabaseAssistiveJobRepository(client);
  const inputs = new SupabaseAssistiveInputRepository(client);
  // The frozen provider is opt-in through an operator-provisioned local model directory.
  const paddleModelsDir = process.env.CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR?.trim() || undefined;
  const worker = new PythonAssistiveWorkerProcess({ paddleModelsDir });
  const coordinator = new AssistiveValidationCoordinator(
    jobs,
    inputs,
    'project-drafts-private',
    worker,
    randomUUID(),
    paddleModelsDir ? 'PADDLE_TITLE' : 'NONE',
  );
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });

  const run = async () => {
    if (mode === '--health') {
      const [database, python] = await Promise.all([getAssistiveWorkerHealth(jobs), worker.health()]);
      const healthy = database.resultCode === 'HEALTHY' && python;
      console.log(JSON.stringify({
        schemaVersion: 'assistive-coordinator-health/v1',
        status: healthy ? 'OK' : 'UNHEALTHY',
        database: database.resultCode,
        python: python ? 'OK' : 'UNHEALTHY',
      }));
      if (!healthy) process.exitCode = 1;
      return;
    }

    do {
      const result = await coordinator.runOnce();
      console.log(JSON.stringify({ outcome: result.outcome, runId: 'runId' in result ? result.runId : null }));
      if (mode !== '--loop' || stopping) return;
      if (result.outcome === 'EMPTY') await new Promise((done) => setTimeout(done, 2_000));
    } while (!stopping);
  };

  run().catch(() => {
    console.error('[Assistive coordinator] bounded coordinator failure');
    process.exitCode = 1;
  });
}
