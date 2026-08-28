import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { createAssistiveCoordinatorRuntime } from '../assistive-validation/services/assistiveCoordinatorRuntime';
import { getHostedAssistiveWorkerConfig } from '../assistive-validation/services/hostedAssistiveWorkerConfig';
import { runOnDemandAssistiveWorker } from '../assistive-validation/services/onDemandAssistiveWorkerLoop';
import { SupabaseAssistiveExecutionControlRepository } from '../assistive-validation/repositories/assistiveExecutionControlRepository';
import { redactReservationToken } from '../assistive-validation/domain/executionControlContract';

/**
 * Scale-to-zero heavy worker entry point.
 *
 * The dispatcher-authorised reservation is claimed before any provider is constructed, so an
 * unauthorised execution exits without loading PaddleOCR or LanguageTool.
 */

const root = path.resolve(__dirname, '../../../..');
const config = getHostedAssistiveWorkerConfig();
if (config.executionMode !== 'ON_DEMAND' || !config.reservation || !config.imageDigest) {
  throw new Error('On-demand assistive execution requires an authorised reservation.');
}
const reservation = config.reservation;
const imageDigest = config.imageDigest;

const controlClient = createClient(config.supabaseUrl, config.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const control = new SupabaseAssistiveExecutionControlRepository(controlClient);

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

runOnDemandAssistiveWorker({
  signal: controller.signal,
  reservation,
  identity: {
    workerInstanceId: config.workerInstanceId,
    deploymentVersion: config.deploymentVersion,
    imageDigest,
  },
  control,
  createRuntime: () => {
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
    return {
      health: runtime.health,
      runOnce: () => runtime.coordinator.runOnce(),
      heartbeat: runtime.heartbeat,
      report: (result) => {
        console.log(JSON.stringify({
          outcome: result.outcome,
          runId: 'runId' in result ? result.runId : null,
        }));
      },
    };
  },
}).then((result) => {
  console.log(JSON.stringify({
    schemaVersion: 'assistive-on-demand-execution/v1',
    outcome: result.outcome,
    processedJobCount: result.processedJobCount,
    reservationToken: redactReservationToken(reservation.token),
  }));
}).catch(() => {
  console.error('[On-demand assistive coordinator] bounded worker failure');
  process.exitCode = 1;
});
