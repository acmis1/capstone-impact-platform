import { execSync } from 'node:child_process';
import path from 'node:path';

import { createAssistiveCoordinatorRuntime } from '../assistive-validation/services/assistiveCoordinatorRuntime';
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
  // The frozen provider is opt-in through an operator-provisioned local model directory.
  const paddleModelsDir = process.env.CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR?.trim() || undefined;
  const languageToolArchive = process.env.CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE?.trim() || undefined;
  const languageToolJar = process.env.CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR?.trim() || undefined;
  const runtime = createAssistiveCoordinatorRuntime({
    supabaseUrl: local.API_URL,
    supabaseCredential: local.SERVICE_ROLE_KEY,
    workerRoot: path.resolve(root, 'apps/assistive-worker'),
    paddleModelsDir,
    languageToolArchive,
    languageToolJar,
  });
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });

  const run = async () => {
    if (mode === '--health') {
      const health = await runtime.healthReport();
      const healthy = health.database.resultCode === 'HEALTHY' && health.python && health.language;
      console.log(JSON.stringify({
        schemaVersion: 'assistive-coordinator-health/v1',
        status: healthy ? 'OK' : 'UNHEALTHY',
        database: health.database.resultCode,
        python: health.python ? 'OK' : 'UNHEALTHY',
        language: health.languageEnabled ? (health.language ? 'OK' : 'UNHEALTHY') : 'DISABLED',
      }));
      if (!healthy) process.exitCode = 1;
      return;
    }

    do {
      const result = await runtime.coordinator.runOnce();
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
