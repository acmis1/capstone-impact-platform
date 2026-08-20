import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  AssistiveRecordableDisposition,
  AssistiveRunPersistenceInput,
} from '../domain/persistenceContract';

/**
 * Server-only gateway over the Migration 0030 assistive persistence functions.
 *
 * Both assistive tables revoke every privilege from PUBLIC, anon, authenticated and service_role
 * and carry a RESTRICTIVE deny-all policy, so there is no direct table access to implement here.
 * Every operation is one SECURITY DEFINER RPC granted to service_role alone, which is why a
 * browser client cannot insert a finding, rewrite persisted evidence, or spoof a disposition.
 *
 * Raw PostgREST errors are converted into bounded thrown codes and never returned to a caller.
 */
export interface AssistiveValidationPersistenceGateway {
  /** Persists one terminal run together with all of its findings, atomically. */
  persistRun(input: AssistiveRunPersistenceInput, actorAdminUserId: string): Promise<unknown>;
  /** Loads the latest run for one project and pipeline version, with its findings. */
  loadLatestRun(projectId: string, pipelineVersion: string): Promise<unknown>;
  /** Records a reviewer disposition against exactly one finding. */
  recordDisposition(
    findingId: string,
    actorAdminUserId: string,
    disposition: AssistiveRecordableDisposition,
  ): Promise<unknown>;
}

export class SupabaseAssistiveValidationRepository implements AssistiveValidationPersistenceGateway {
  constructor(private readonly client: SupabaseClient) {}

  async persistRun(input: AssistiveRunPersistenceInput, actorAdminUserId: string): Promise<unknown> {
    const { data, error } = await this.client.rpc('persist_assistive_validation_run', {
      p_project_id: input.projectId,
      // Server-derived staff identity. A browser-supplied value must never reach this argument.
      p_actor_admin_id: actorAdminUserId,
      p_input_hash: input.inputHash,
      p_pipeline_version: input.pipelineVersion,
      p_status: input.status,
      p_failure_code: input.failureCode,
      p_findings: input.findings,
    });
    if (error) throw new Error('ASSISTIVE_RUN_PERSIST_FAILED');
    return data;
  }

  async loadLatestRun(projectId: string, pipelineVersion: string): Promise<unknown> {
    const { data, error } = await this.client.rpc('get_latest_assistive_validation_run', {
      p_project_id: projectId,
      p_pipeline_version: pipelineVersion,
    });
    if (error) throw new Error('ASSISTIVE_RUN_READ_FAILED');
    return data;
  }

  async recordDisposition(
    findingId: string,
    actorAdminUserId: string,
    disposition: AssistiveRecordableDisposition,
  ): Promise<unknown> {
    const { data, error } = await this.client.rpc('record_assistive_finding_disposition', {
      p_finding_id: findingId,
      p_actor_admin_id: actorAdminUserId,
      p_disposition: disposition,
    });
    if (error) throw new Error('ASSISTIVE_DISPOSITION_FAILED');
    return data;
  }
}
