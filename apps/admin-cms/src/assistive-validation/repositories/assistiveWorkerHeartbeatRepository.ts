import type { SupabaseClient } from '@supabase/supabase-js';

import type { StagingRuntimeEnvironment } from '../../security/stagingRuntimeIdentity';
import {
  ASSISTIVE_WORKER_COMPATIBILITY,
  ASSISTIVE_WORKER_FRESHNESS_SECONDS,
  type AssistiveWorkerEnvironment,
  type AssistiveWorkerHealthState,
} from '../domain/workerHeartbeatContract';

export interface AssistiveWorkerRuntimeIdentity {
  environment: string | undefined;
  deploymentVersion: string;
}

const CANONICAL_DEPLOYMENT_VERSION = /^[a-f0-9]{40}$/;

/**
 * Binds the configured expected worker commit to the application's independently supplied
 * deployment identity. Render's commit is accepted only with its provider marker; a
 * provider-neutral host must supply CAPSTONE_DEPLOYMENT_VERSION instead. Every populated identity
 * must be the same exact lowercase full SHA.
 */
export function resolveAssistiveWorkerRuntimeIdentity(
  env: StagingRuntimeEnvironment = process.env,
): AssistiveWorkerRuntimeIdentity | null {
  const environment = env.CAPSTONE_RUNTIME_ENV;
  if (environment !== 'staging' && environment !== 'production') return null;

  const expected = env.CAPSTONE_ASSISTIVE_EXPECTED_WORKER_DEPLOYMENT_VERSION;
  if (!expected || !CANONICAL_DEPLOYMENT_VERSION.test(expected)) return null;

  const canonicalRuntime = env.CAPSTONE_DEPLOYMENT_VERSION;
  const renderRuntime = env.RENDER_GIT_COMMIT;
  if (!canonicalRuntime && !renderRuntime) return null;
  if (canonicalRuntime !== undefined
      && (!CANONICAL_DEPLOYMENT_VERSION.test(canonicalRuntime) || canonicalRuntime !== expected)) {
    return null;
  }
  if (renderRuntime !== undefined
      && (env.RENDER !== 'true'
        || !CANONICAL_DEPLOYMENT_VERSION.test(renderRuntime)
        || renderRuntime !== expected)) {
    return null;
  }

  return { environment, deploymentVersion: expected };
}

export interface AssistiveWorkerHeartbeatGateway {
  record(input: {
    workerInstanceId: string;
    deploymentVersion: string;
    healthState: AssistiveWorkerHealthState;
  }): Promise<unknown>;
  availability(): Promise<unknown>;
}

export class SupabaseAssistiveWorkerHeartbeatRepository implements AssistiveWorkerHeartbeatGateway {
  constructor(
    private readonly client: SupabaseClient,
    private readonly runtimeIdentity: AssistiveWorkerRuntimeIdentity | null,
  ) {}

  private identity(): AssistiveWorkerRuntimeIdentity | null {
    const identity = this.runtimeIdentity;
    return identity
      && (identity.environment === 'staging' || identity.environment === 'production')
      && CANONICAL_DEPLOYMENT_VERSION.test(identity.deploymentVersion)
      ? identity
      : null;
  }

  private async rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.rpc(name, parameters);
    if (error) throw new Error('ASSISTIVE_WORKER_HEARTBEAT_RPC_FAILED');
    return data;
  }

  record(input: {
    workerInstanceId: string;
    deploymentVersion: string;
    healthState: AssistiveWorkerHealthState;
  }) {
    const identity = this.identity();
    if (!identity || input.deploymentVersion !== identity.deploymentVersion) {
      return Promise.resolve({ resultCode: 'VALIDATION_FAILED' });
    }
    return this.rpc('upsert_assistive_worker_heartbeat', {
      p_worker_instance_id: input.workerInstanceId,
      p_environment: identity.environment as AssistiveWorkerEnvironment,
      p_pipeline_version: ASSISTIVE_WORKER_COMPATIBILITY.pipelineVersion,
      p_deployment_version: input.deploymentVersion,
      p_ocr_capability: ASSISTIVE_WORKER_COMPATIBILITY.ocrCapability,
      p_language_capability: ASSISTIVE_WORKER_COMPATIBILITY.languageCapability,
      p_health_state: input.healthState,
    });
  }

  availability() {
    const identity = this.identity();
    if (!identity) return Promise.resolve({ resultCode: 'VALIDATION_FAILED' });
    return this.rpc('get_assistive_worker_availability', {
      p_environment: identity.environment as AssistiveWorkerEnvironment,
      p_pipeline_version: ASSISTIVE_WORKER_COMPATIBILITY.pipelineVersion,
      p_deployment_version: identity.deploymentVersion,
      p_ocr_capability: ASSISTIVE_WORKER_COMPATIBILITY.ocrCapability,
      p_language_capability: ASSISTIVE_WORKER_COMPATIBILITY.languageCapability,
      p_freshness_seconds: ASSISTIVE_WORKER_FRESHNESS_SECONDS,
    });
  }
}
