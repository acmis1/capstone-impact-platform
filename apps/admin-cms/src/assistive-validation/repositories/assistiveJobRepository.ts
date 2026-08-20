import type { SupabaseClient } from '@supabase/supabase-js';

import type { PersistedAssistiveFinding } from '../domain/persistenceContract';

export interface AssistiveJobGateway {
  enqueue(projectId: string, actorId: string, inputHash: string, pipelineVersion: string): Promise<unknown>;
  status(runId: string): Promise<unknown>;
  cancel(runId: string, actorId: string): Promise<unknown>;
  health(): Promise<unknown>;
  claim(workerId: string, leaseSeconds: number): Promise<unknown>;
  heartbeat(jobId: string, claimToken: string, leaseSeconds: number): Promise<unknown>;
  advance(jobId: string, claimToken: string): Promise<unknown>;
  supersede(jobId: string, claimToken: string): Promise<unknown>;
  fail(jobId: string, claimToken: string, failureCode: string): Promise<unknown>;
  finalize(input: {
    jobId: string;
    claimToken: string;
    inputHash: string;
    status: 'COMPLETED' | 'PARTIAL';
    completionCode: 'OCR_REQUIRED' | 'OCR_PROVIDER_UNAVAILABLE' | null;
    findings: PersistedAssistiveFinding[];
  }): Promise<unknown>;
}

export class SupabaseAssistiveJobRepository implements AssistiveJobGateway {
  constructor(private readonly client: SupabaseClient) {}

  private async rpc(name: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await this.client.rpc(name, parameters);
    if (error) throw new Error('ASSISTIVE_JOB_RPC_FAILED');
    return data;
  }

  enqueue(projectId: string, actorId: string, inputHash: string, pipelineVersion: string) {
    return this.rpc('enqueue_assistive_validation_run', {
      p_project_id: projectId, p_actor_admin_id: actorId,
      p_input_hash: inputHash, p_pipeline_version: pipelineVersion,
    });
  }

  status(runId: string) {
    return this.rpc('get_assistive_validation_run_status', { p_run_id: runId });
  }

  cancel(runId: string, actorId: string) {
    return this.rpc('request_assistive_validation_cancellation', {
      p_run_id: runId, p_actor_admin_id: actorId,
    });
  }

  health() { return this.rpc('get_assistive_validation_job_health'); }

  claim(workerId: string, leaseSeconds: number) {
    return this.rpc('claim_next_assistive_validation_job', {
      p_worker_id: workerId, p_lease_seconds: leaseSeconds,
    });
  }

  heartbeat(jobId: string, claimToken: string, leaseSeconds: number) {
    return this.rpc('heartbeat_assistive_validation_job', {
      p_job_id: jobId, p_claim_token: claimToken, p_lease_seconds: leaseSeconds,
    });
  }

  advance(jobId: string, claimToken: string) {
    return this.rpc('advance_assistive_validation_job_stage', {
      p_job_id: jobId, p_claim_token: claimToken,
    });
  }

  supersede(jobId: string, claimToken: string) {
    return this.rpc('supersede_assistive_validation_job', {
      p_job_id: jobId, p_claim_token: claimToken,
    });
  }

  fail(jobId: string, claimToken: string, failureCode: string) {
    return this.rpc('record_assistive_validation_job_failure', {
      p_job_id: jobId, p_claim_token: claimToken, p_failure_code: failureCode,
    });
  }

  finalize(input: Parameters<AssistiveJobGateway['finalize']>[0]) {
    return this.rpc('finalize_assistive_validation_job', {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_input_hash: input.inputHash,
      p_status: input.status,
      p_completion_code: input.completionCode,
      p_findings: input.findings,
    });
  }
}
