import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { SupabaseAssistiveInputRepository } from '../repositories/assistiveInputRepository';
import { SupabaseAssistiveJobRepository } from '../repositories/assistiveJobRepository';
import { SupabaseAssistiveWorkerHeartbeatRepository } from '../repositories/assistiveWorkerHeartbeatRepository';
import { AssistiveValidationCoordinator } from './assistiveCoordinator';
import { getAssistiveWorkerHealth } from './assistiveJobService';
import { AssistiveWorkerHeartbeatPublisher } from './assistiveWorkerHeartbeat';
import { LocalLanguageToolProcess } from './languageToolProcess';
import { PythonAssistiveWorkerProcess } from './pythonWorkerProcess';

interface AssistiveCoordinatorRuntimeConfig {
  supabaseUrl: string;
  supabaseCredential: string;
  workerRoot: string;
  paddleModelsDir?: string;
  languageToolArchive?: string;
  languageToolJar?: string;
  heartbeatIdentity?: {
    workerInstanceId: string;
    deploymentVersion: string;
  };
}

export function createAssistiveCoordinatorRuntime(config: AssistiveCoordinatorRuntimeConfig) {
  if (Boolean(config.languageToolArchive) !== Boolean(config.languageToolJar)) {
    throw new Error('Both LanguageTool artifact paths must be configured together.');
  }
  const client = createClient(config.supabaseUrl, config.supabaseCredential, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const jobs = new SupabaseAssistiveJobRepository(client);
  const inputs = new SupabaseAssistiveInputRepository(client);
  const worker = new PythonAssistiveWorkerProcess({
    workerRoot: path.resolve(config.workerRoot),
    paddleModelsDir: config.paddleModelsDir,
  });
  const language = config.languageToolArchive && config.languageToolJar
    ? new LocalLanguageToolProcess({
        archivePath: config.languageToolArchive,
        jarPath: config.languageToolJar,
      })
    : null;
  const coordinator = new AssistiveValidationCoordinator(
    jobs,
    inputs,
    'project-drafts-private',
    worker,
    randomUUID(),
    config.paddleModelsDir ? 'PADDLE_TITLE' : 'NONE',
    language,
  );
  const heartbeat = config.heartbeatIdentity
    ? new AssistiveWorkerHeartbeatPublisher(
        new SupabaseAssistiveWorkerHeartbeatRepository(client, config.heartbeatIdentity.deploymentVersion),
        config.heartbeatIdentity.workerInstanceId,
        config.heartbeatIdentity.deploymentVersion,
      )
    : null;

  async function healthReport() {
    const [database, python, languageHealthy] = await Promise.all([
      getAssistiveWorkerHealth(jobs),
      worker.health(),
      language?.health() ?? Promise.resolve(true),
    ]);
    return { database, python, language: languageHealthy, languageEnabled: language !== null };
  }

  return {
    coordinator,
    heartbeat,
    healthReport,
    async health(): Promise<boolean> {
      const report = await healthReport();
      return report.database.resultCode === 'HEALTHY' && report.python && report.language;
    },
  };
}
