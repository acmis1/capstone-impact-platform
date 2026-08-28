import { basename, isAbsolute } from 'node:path';

import { classifySupabaseCredential } from '../../lib/supabaseCredential';
import { assertVerifiedStagingRuntime, type StagingRuntimeEnvironment } from '../../security/stagingRuntimeIdentity';

export interface HostedAssistiveWorkerConfig {
  supabaseUrl: string;
  supabaseSecretKey: string;
  workerInstanceId: string;
  deploymentVersion: string;
  paddleModelsDir: string;
  languageToolArchive: string;
  languageToolJar: string;
}

function requiredCanonicalValue(env: StagingRuntimeEnvironment, name: string): string {
  const value = env[name];
  if (!value || value !== value.trim()) throw new Error(`Hosted assistive worker configuration is invalid: ${name}.`);
  return value;
}

export function getHostedAssistiveWorkerConfig(
  env: StagingRuntimeEnvironment = process.env,
): HostedAssistiveWorkerConfig {
  if (env.CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED !== 'true') {
    throw new Error('Hosted assistive worker execution is not explicitly enabled.');
  }

  const supabaseUrl = requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_SUPABASE_URL');
  assertVerifiedStagingRuntime({ ...env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl });

  const supabaseSecretKey = requiredCanonicalValue(env, 'SUPABASE_SECRET_KEY');
  if (classifySupabaseCredential(supabaseSecretKey, true) !== 'secret') {
    throw new Error('Hosted assistive worker database credential is not an approved server secret.');
  }

  const workerInstanceId = requiredCanonicalValue(env, 'RENDER_INSTANCE_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerInstanceId)) {
    throw new Error('Hosted assistive worker instance identity is invalid.');
  }

  const deploymentVersion = requiredCanonicalValue(env, 'RENDER_GIT_COMMIT').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(deploymentVersion)) {
    throw new Error('Hosted assistive worker deployment identity is invalid.');
  }

  const paddleModelsDir = requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR');
  const languageToolArchive = requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE');
  const languageToolJar = requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR');
  if (!isAbsolute(paddleModelsDir)
      || !isAbsolute(languageToolArchive)
      || !isAbsolute(languageToolJar)
      || basename(languageToolArchive) !== 'LanguageTool-stable.zip'
      || basename(languageToolJar) !== 'languagetool-server.jar') {
    throw new Error('Hosted assistive worker provider artifact configuration is invalid.');
  }

  return {
    supabaseUrl,
    supabaseSecretKey,
    workerInstanceId,
    deploymentVersion,
    paddleModelsDir,
    languageToolArchive,
    languageToolJar,
  };
}
