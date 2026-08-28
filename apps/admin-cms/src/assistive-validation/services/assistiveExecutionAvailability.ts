import { isLoopbackUrl } from '../../local-development/localEnvironmentFile';
import { getServerEnv } from '../../lib/env';
import { isVerifiedStagingRuntime, type StagingRuntimeEnvironment } from '../../security/stagingRuntimeIdentity';
import type { AssistiveWorkerHeartbeatGateway } from '../repositories/assistiveWorkerHeartbeatRepository';
import { hasCompatibleAssistiveWorker } from './assistiveWorkerHeartbeat';

/**
 * Checks whether assistive validation execution is supported in the current environment.
 *
 * Local execution remains available on loopback. Hosted execution fails closed unless this is the
 * explicitly enabled, verified staging target and a compatible dedicated worker heartbeat is fresh.
 */
export async function isAssistiveExecutionAvailable(
  supabaseUrl?: string,
  heartbeatGateway?: AssistiveWorkerHeartbeatGateway,
  env: StagingRuntimeEnvironment = process.env,
): Promise<boolean> {
  try {
    const url = supabaseUrl ?? getServerEnv().NEXT_PUBLIC_SUPABASE_URL;
    if (!url) return false;
    if (isLoopbackUrl(url)) return true;
    if (env.CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED !== 'true'
        || !heartbeatGateway
        || !isVerifiedStagingRuntime({ ...env, NEXT_PUBLIC_SUPABASE_URL: url })) {
      return false;
    }
    return await hasCompatibleAssistiveWorker(heartbeatGateway);
  } catch {
    return false;
  }
}
