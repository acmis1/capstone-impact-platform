import type { SupabaseClient } from '@supabase/supabase-js';

import { ASSISTIVE_PIPELINE_VERSION } from '../domain/persistenceContract';
import {
  ASSISTIVE_LANGUAGE_CAPABILITY,
  ASSISTIVE_OCR_CAPABILITY,
} from '../domain/workerHeartbeatContract';
import { EXECUTOR_REGISTRATION_DAYS } from '../domain/executionControlContract';

/**
 * Server-side execution-control surface reached through the existing PostgREST service-role
 * boundary. The dispatcher never uses this gateway: its own least-privilege role has no access to
 * these routines.
 */
export interface AssistiveExecutionControlGateway {
  register(input: {
    deploymentVersion: string;
    imageDigest: string;
    configurationVersion: string;
  }): Promise<unknown>;
  claim(input: {
    reservationToken: string;
    generation: number;
    workerInstanceId: string;
    deploymentVersion: string;
    imageDigest: string;
    executionMode: string;
  }): Promise<unknown>;
  settle(input: {
    reservationToken: string;
    generation: number;
    outcome: 'COMPLETED' | 'FAILED';
    processedJobCount: number;
  }): Promise<unknown>;
  availability(input: { deploymentVersion: string; imageDigest: string }): Promise<unknown>;
}

export class SupabaseAssistiveExecutionControlRepository implements AssistiveExecutionControlGateway {
  constructor(private readonly client: SupabaseClient) {}

  private async rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.rpc(name, parameters);
    if (error) throw new Error('ASSISTIVE_EXECUTION_CONTROL_RPC_FAILED');
    return data;
  }

  register(input: Parameters<AssistiveExecutionControlGateway['register']>[0]) {
    return this.rpc('register_assistive_executor', {
      p_deployment_version: input.deploymentVersion,
      p_image_digest: input.imageDigest,
      p_configuration_version: input.configurationVersion,
      p_registration_days: EXECUTOR_REGISTRATION_DAYS,
    });
  }

  claim(input: Parameters<AssistiveExecutionControlGateway['claim']>[0]) {
    return this.rpc('claim_assistive_execution_reservation', {
      p_reservation_token: input.reservationToken,
      p_generation: input.generation,
      p_worker_instance_id: input.workerInstanceId,
      p_deployment_version: input.deploymentVersion,
      p_image_digest: input.imageDigest,
      p_execution_mode: input.executionMode,
    });
  }

  settle(input: Parameters<AssistiveExecutionControlGateway['settle']>[0]) {
    return this.rpc('settle_assistive_execution_reservation', {
      p_reservation_token: input.reservationToken,
      p_generation: input.generation,
      p_outcome: input.outcome,
      p_processed_job_count: input.processedJobCount,
    });
  }

  availability(input: Parameters<AssistiveExecutionControlGateway['availability']>[0]) {
    return this.rpc('get_assistive_executor_availability', {
      p_pipeline_version: ASSISTIVE_PIPELINE_VERSION,
      p_deployment_version: input.deploymentVersion,
      p_image_digest: input.imageDigest,
      p_ocr_capability: ASSISTIVE_OCR_CAPABILITY,
      p_language_capability: ASSISTIVE_LANGUAGE_CAPABILITY,
    });
  }
}
