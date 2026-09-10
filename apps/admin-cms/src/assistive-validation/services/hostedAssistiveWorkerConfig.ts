import { basename, isAbsolute } from 'node:path';

import { classifySupabaseCredential } from '../../lib/supabaseCredential';
import { isProductionAssistiveEnabled } from '../../security/operationalProductionCapabilities';
import {
  assertVerifiedProductionRuntime,
  assertVerifiedStagingRuntime,
  type StagingRuntimeEnvironment,
} from '../../security/stagingRuntimeIdentity';
import type { AssistiveExecutionMode } from '../domain/executionControlContract';
import type { AssistiveWorkerEnvironment } from '../domain/workerHeartbeatContract';

export interface HostedAssistiveWorkerConfig {
  runtimeEnvironment: AssistiveWorkerEnvironment;
  supabaseUrl: string;
  supabaseSecretKey: string;
  workerInstanceId: string;
  deploymentVersion: string;
  executionMode: AssistiveExecutionMode;
  /** Immutable image identity. Required for on-demand execution, absent for continuous hosts. */
  imageDigest: string | null;
  /** Supplied per execution by the dispatcher. Absent for continuous execution. */
  reservation: { token: string; generation: number } | null;
  paddleModelsDir: string;
  languageToolArchive: string;
  languageToolJar: string;
}

function requiredCanonicalValue(env: StagingRuntimeEnvironment, name: string): string {
  const value = env[name];
  if (!value || value !== value.trim()) throw new Error(`Hosted assistive worker configuration is invalid: ${name}.`);
  return value;
}

/**
 * Reads a provider-neutral value, accepting the historical Render-supplied name as an alias so the
 * existing continuous hosted profile keeps working unchanged. Provider-specific names are aliases
 * only; they are never the canonical identity.
 */
function neutralValue(
  env: StagingRuntimeEnvironment,
  canonicalName: string,
  legacyName: string,
): string {
  const canonical = env[canonicalName];
  if (canonical !== undefined) return requiredCanonicalValue(env, canonicalName);
  return requiredCanonicalValue(env, legacyName);
}

export function getHostedAssistiveWorkerConfig(
  env: StagingRuntimeEnvironment = process.env,
): HostedAssistiveWorkerConfig {
  if (env.CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED !== 'true') {
    throw new Error('Hosted assistive worker execution is not explicitly enabled.');
  }

  const supabaseUrl = requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_SUPABASE_URL');
  const runtimeEnv = { ...env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl };
  if (env.CAPSTONE_RUNTIME_ENV === 'production') {
    if (!isProductionAssistiveEnabled(env)) {
      throw new Error('Production assistive worker execution is not explicitly enabled.');
    }
    assertVerifiedProductionRuntime(runtimeEnv);
  } else {
    assertVerifiedStagingRuntime(runtimeEnv);
  }

  const supabaseSecretKey = requiredCanonicalValue(env, 'SUPABASE_SECRET_KEY');
  if (classifySupabaseCredential(supabaseSecretKey, true) !== 'secret') {
    throw new Error('Hosted assistive worker database credential is not an approved server secret.');
  }

  const workerInstanceId = neutralValue(
    env,
    'CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID',
    'RENDER_INSTANCE_ID',
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerInstanceId)) {
    throw new Error('Hosted assistive worker instance identity is invalid.');
  }

  const canonicalDeploymentVersion = env.CAPSTONE_DEPLOYMENT_VERSION;
  const legacyDeploymentVersion = env.RENDER_GIT_COMMIT;
  if (canonicalDeploymentVersion !== undefined
      && legacyDeploymentVersion !== undefined
      && canonicalDeploymentVersion !== legacyDeploymentVersion) {
    throw new Error('Hosted assistive worker deployment identity is invalid.');
  }
  const deploymentVersion = neutralValue(
    env,
    'CAPSTONE_DEPLOYMENT_VERSION',
    'RENDER_GIT_COMMIT',
  );
  if (!/^[a-f0-9]{40}$/.test(deploymentVersion)) {
    throw new Error('Hosted assistive worker deployment identity is invalid.');
  }

  const requestedMode = env.CAPSTONE_ASSISTIVE_EXECUTION_MODE ?? 'CONTINUOUS';
  if (requestedMode !== 'CONTINUOUS' && requestedMode !== 'ON_DEMAND') {
    throw new Error('Hosted assistive worker execution mode is invalid.');
  }
  const executionMode: AssistiveExecutionMode = requestedMode;
  if (env.CAPSTONE_RUNTIME_ENV === 'production' && executionMode !== 'CONTINUOUS') {
    throw new Error('Production assistive worker execution must use continuous mode.');
  }

  let imageDigest: string | null = null;
  let reservation: HostedAssistiveWorkerConfig['reservation'] = null;
  if (executionMode === 'ON_DEMAND') {
    imageDigest = requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_IMAGE_DIGEST');
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
      throw new Error('Hosted assistive worker image identity is invalid.');
    }
    const token = requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_RESERVATION_TOKEN');
    const generation = Number(requiredCanonicalValue(env, 'CAPSTONE_ASSISTIVE_RESERVATION_GENERATION'));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
        || !Number.isSafeInteger(generation)
        || generation <= 0) {
      throw new Error('Hosted assistive worker execution reservation is invalid.');
    }
    reservation = { token, generation };
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
    runtimeEnvironment: env.CAPSTONE_RUNTIME_ENV === 'production' ? 'production' : 'staging',
    supabaseUrl,
    supabaseSecretKey,
    workerInstanceId,
    deploymentVersion,
    executionMode,
    imageDigest,
    reservation,
    paddleModelsDir,
    languageToolArchive,
    languageToolJar,
  };
}
