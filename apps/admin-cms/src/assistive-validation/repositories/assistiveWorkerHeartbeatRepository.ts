import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ASSISTIVE_WORKER_COMPATIBILITY,
  ASSISTIVE_WORKER_FRESHNESS_SECONDS,
  type AssistiveWorkerHealthState,
} from '../domain/workerHeartbeatContract';

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
    private readonly deploymentVersion: string,
  ) {}

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
    return this.rpc('upsert_assistive_worker_heartbeat', {
      p_worker_instance_id: input.workerInstanceId,
      p_environment: ASSISTIVE_WORKER_COMPATIBILITY.environment,
      p_pipeline_version: ASSISTIVE_WORKER_COMPATIBILITY.pipelineVersion,
      p_deployment_version: input.deploymentVersion,
      p_ocr_capability: ASSISTIVE_WORKER_COMPATIBILITY.ocrCapability,
      p_language_capability: ASSISTIVE_WORKER_COMPATIBILITY.languageCapability,
      p_health_state: input.healthState,
    });
  }

  availability() {
    return this.rpc('get_assistive_worker_availability', {
      p_environment: ASSISTIVE_WORKER_COMPATIBILITY.environment,
      p_pipeline_version: ASSISTIVE_WORKER_COMPATIBILITY.pipelineVersion,
      p_deployment_version: this.deploymentVersion,
      p_ocr_capability: ASSISTIVE_WORKER_COMPATIBILITY.ocrCapability,
      p_language_capability: ASSISTIVE_WORKER_COMPATIBILITY.languageCapability,
      p_freshness_seconds: ASSISTIVE_WORKER_FRESHNESS_SECONDS,
    });
  }
}
