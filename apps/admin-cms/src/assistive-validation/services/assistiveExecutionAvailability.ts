import { isLoopbackUrl } from '../../local-development/localEnvironmentFile';
import { isProductionAssistiveEnabled } from '../../security/operationalProductionCapabilities';
import {
  isVerifiedProductionRuntime,
  isVerifiedStagingRuntime,
  type StagingRuntimeEnvironment,
} from '../../security/stagingRuntimeIdentity';
import { executorAvailabilityResponseSchema } from '../domain/executionControlContract';
import type { AssistiveExecutionControlGateway } from '../repositories/assistiveExecutionControlRepository';
import {
  resolveAssistiveWorkerRuntimeIdentity,
  type AssistiveWorkerHeartbeatGateway,
} from '../repositories/assistiveWorkerHeartbeatRepository';
import { hasCompatibleAssistiveWorker } from './assistiveWorkerHeartbeat';

/**
 * Staff-facing execution states.
 *
 * These are deliberately truthful about scale-to-zero: `ON_DEMAND_READY` means processing can be
 * started on request, not that a worker is currently running. No cloud provider name is exposed.
 */
export type AssistiveExecutionState =
  | 'LOCAL_READY'
  | 'READY'
  | 'ON_DEMAND_READY'
  | 'BUDGET_REACHED'
  | 'TEMPORARILY_UNAVAILABLE';

export interface AssistiveExecutionAvailability {
  readonly state: AssistiveExecutionState;
  readonly canEnqueue: boolean;
  readonly message: string | null;
}

const UNAVAILABLE_MESSAGE =
  'Assistive checks are temporarily unavailable because the processing worker is not ready.';
const BUDGET_MESSAGE =
  'Assistive checks have reached their processing limit for now. You can continue reviewing and '
  + 'requesting corrected project-team packages through the normal workflow.';

function unavailable(): AssistiveExecutionAvailability {
  return { state: 'TEMPORARILY_UNAVAILABLE', canEnqueue: false, message: UNAVAILABLE_MESSAGE };
}

async function resolveOnDemandAvailability(
  gateway: AssistiveExecutionControlGateway,
  env: StagingRuntimeEnvironment,
): Promise<AssistiveExecutionAvailability | null> {
  const deploymentVersion = env.CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION;
  const imageDigest = env.CAPSTONE_ASSISTIVE_EXPECTED_WORKER_IMAGE_DIGEST;
  if (!deploymentVersion || !imageDigest) return null;

  const parsed = executorAvailabilityResponseSchema.safeParse(
    await gateway.availability({ deploymentVersion, imageDigest }),
  );
  if (!parsed.success || parsed.data.resultCode === 'VALIDATION_FAILED') return null;
  if (parsed.data.resultCode === 'BUDGET_EXHAUSTED') {
    return { state: 'BUDGET_REACHED', canEnqueue: false, message: BUDGET_MESSAGE };
  }
  if (parsed.data.resultCode === 'UNAVAILABLE') return null;
  return { state: 'ON_DEMAND_READY', canEnqueue: true, message: null };
}

/**
 * Resolves whether assistive validation execution is supported in the current environment.
 *
 * Local execution remains available on loopback. Hosted execution fails closed unless this is the
 * explicitly enabled, verified hosted target. Staging may use a compatible continuous heartbeat or
 * its existing on-demand executor. Production requires its separate capability and a compatible
 * continuous heartbeat; it never consults on-demand execution control.
 */
export async function resolveAssistiveExecutionAvailability(
  supabaseUrl?: string,
  heartbeatGateway?: AssistiveWorkerHeartbeatGateway,
  executionControlGateway?: AssistiveExecutionControlGateway,
  env: StagingRuntimeEnvironment = process.env,
): Promise<AssistiveExecutionAvailability> {
  try {
    const url = supabaseUrl ?? env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) return unavailable();
    if (isLoopbackUrl(url)) return { state: 'LOCAL_READY', canEnqueue: true, message: null };
    if (env.CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED !== 'true') {
      return unavailable();
    }

    const runtimeEnv = { ...env, NEXT_PUBLIC_SUPABASE_URL: url };
    const production = env.CAPSTONE_RUNTIME_ENV === 'production';
    if (production) {
      if (!isProductionAssistiveEnabled(env) || !isVerifiedProductionRuntime(runtimeEnv)) {
        return unavailable();
      }
    } else if (!isVerifiedStagingRuntime(runtimeEnv)) {
      return unavailable();
    }

    if (!resolveAssistiveWorkerRuntimeIdentity(env)) return unavailable();

    if (heartbeatGateway && await hasCompatibleAssistiveWorker(heartbeatGateway)) {
      return { state: 'READY', canEnqueue: true, message: null };
    }
    if (!production && executionControlGateway) {
      const onDemand = await resolveOnDemandAvailability(executionControlGateway, env);
      if (onDemand) return onDemand;
    }
    return unavailable();
  } catch {
    return unavailable();
  }
}

/** Boolean form retained for existing call sites and contract tests. */
export async function isAssistiveExecutionAvailable(
  supabaseUrl?: string,
  heartbeatGateway?: AssistiveWorkerHeartbeatGateway,
  env: StagingRuntimeEnvironment = process.env,
  executionControlGateway?: AssistiveExecutionControlGateway,
): Promise<boolean> {
  const availability = await resolveAssistiveExecutionAvailability(
    supabaseUrl,
    heartbeatGateway,
    executionControlGateway,
    env,
  );
  return availability.canEnqueue;
}
