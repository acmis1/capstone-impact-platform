import path from 'node:path';

import { createAssistiveCoordinatorRuntime } from '../assistive-validation/services/assistiveCoordinatorRuntime';
import { getHostedAssistiveWorkerConfig } from '../assistive-validation/services/hostedAssistiveWorkerConfig';
import { runHostedAssistiveWorkerLoop } from '../assistive-validation/services/hostedAssistiveWorkerLoop';

const root = path.resolve(__dirname, '../../../..');
const config = getHostedAssistiveWorkerConfig();
const runtime = createAssistiveCoordinatorRuntime({
  supabaseUrl: config.supabaseUrl,
  supabaseCredential: config.supabaseSecretKey,
  workerRoot: path.resolve(root, 'apps/assistive-worker'),
  paddleModelsDir: config.paddleModelsDir,
  languageToolArchive: config.languageToolArchive,
  languageToolJar: config.languageToolJar,
  heartbeatIdentity: {
    workerInstanceId: config.workerInstanceId,
    deploymentVersion: config.deploymentVersion,
  },
});
if (!runtime.heartbeat) throw new Error('Hosted assistive worker heartbeat is not configured.');
const controller = new AbortController();

process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

runHostedAssistiveWorkerLoop({
  signal: controller.signal,
  health: runtime.health,
  runOnce: () => runtime.coordinator.runOnce(),
  heartbeat: runtime.heartbeat,
  report: (result) => {
    console.log(JSON.stringify({
      outcome: result.outcome,
      runId: 'runId' in result ? result.runId : null,
    }));
  },
}).catch(() => {
  console.error('[Hosted assistive coordinator] bounded worker failure');
  process.exitCode = 1;
});
