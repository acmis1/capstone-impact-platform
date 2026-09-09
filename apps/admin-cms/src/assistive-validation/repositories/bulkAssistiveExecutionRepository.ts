import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  assistiveInspectionResponseSchema,
  type StoredAssistiveInspectionRun,
} from '../domain/inspectionContract';
import {
  ASSISTIVE_PIPELINE_VERSION,
  postgresCanonicalUuidSchema,
} from '../domain/persistenceContract';
import { enqueueAssistiveValidation } from '../services/assistiveJobService';
import { loadAssistiveInput } from '../services/assistiveInputService';
import { SupabaseAssistiveInputRepository, type AssistiveInputGateway } from './assistiveInputRepository';
import { SupabaseAssistiveJobRepository, type AssistiveJobGateway } from './assistiveJobRepository';

const projectRowSchema = z.object({
  id: postgresCanonicalUuidSchema,
  public_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().max(400).nullable(),
}).strict();

export interface BulkAssistiveProjectRecord {
  projectId: string;
  publicId: string;
  title: string;
}

export type BulkAssistiveInputInspection =
  | { kind: 'VALID'; inputHash: string }
  | { kind: 'MEDIA_INVALID' }
  | { kind: 'FAILED' };

export interface BulkAssistiveExecutionGateway {
  loadProjects(publicIds: string[]): Promise<Map<string, BulkAssistiveProjectRecord>>;
  inspectInput(projectId: string): Promise<BulkAssistiveInputInspection>;
  loadCurrentRun(projectId: string): Promise<StoredAssistiveInspectionRun | null>;
  enqueueProject(
    projectId: string,
    actorAdminUserId: string,
    expectedInputHash: string,
    expectedProjectPublicId: string,
  ): Promise<unknown>;
}

/**
 * Server-only adapter for bulk assistive execution. It intentionally exposes only the existing
 * per-project enqueue authority; it has no worker-launch or project-mutation capability.
 */
export class SupabaseBulkAssistiveExecutionGateway implements BulkAssistiveExecutionGateway {
  private readonly inputGateway: AssistiveInputGateway;
  private readonly jobGateway: AssistiveJobGateway;

  constructor(
    private readonly client: SupabaseClient,
    private readonly privateBucket: string,
  ) {
    this.inputGateway = new SupabaseAssistiveInputRepository(client);
    this.jobGateway = new SupabaseAssistiveJobRepository(client);
  }

  async loadProjects(publicIds: string[]): Promise<Map<string, BulkAssistiveProjectRecord>> {
    const result = await this.client
      .from('projects')
      .select('id,public_id,title')
      .in('public_id', publicIds)
      .is('deleted_at', null);
    if (result.error) throw new Error('ASSISTIVE_BULK_PROJECT_READ_FAILED');

    const rows = z.array(projectRowSchema).max(publicIds.length).parse(result.data ?? []);
    return new Map(rows.map((row) => [row.public_id, {
      projectId: row.id,
      publicId: row.public_id,
      title: row.title || 'Untitled project',
    }]));
  }

  async inspectInput(projectId: string): Promise<BulkAssistiveInputInspection> {
    try {
      const snapshot = await loadAssistiveInput(this.inputGateway, projectId, this.privateBucket);
      return snapshot ? { kind: 'VALID', inputHash: snapshot.inputHash } : { kind: 'MEDIA_INVALID' };
    } catch {
      return { kind: 'FAILED' };
    }
  }

  async loadCurrentRun(projectId: string): Promise<StoredAssistiveInspectionRun | null> {
    const raw = await this.client.rpc('get_project_assistive_validation_inspection', {
      p_project_id: projectId,
      p_pipeline_version: ASSISTIVE_PIPELINE_VERSION,
      p_run_id: null,
    });
    if (raw.error) throw new Error('ASSISTIVE_BULK_INSPECTION_READ_FAILED');
    const parsed = assistiveInspectionResponseSchema.safeParse(raw.data);
    if (!parsed.success || parsed.data.resultCode === 'VALIDATION_FAILED' || parsed.data.resultCode === 'INVARIANT_VIOLATION') {
      throw new Error('ASSISTIVE_BULK_INSPECTION_INVALID');
    }
    return parsed.data.resultCode === 'NOT_FOUND' ? null : parsed.data.run;
  }

  enqueueProject(
    projectId: string,
    actorAdminUserId: string,
    expectedInputHash: string,
    expectedProjectPublicId: string,
  ): Promise<unknown> {
    return enqueueAssistiveValidation(
      this.jobGateway,
      this.inputGateway,
      {
        projectId,
        actorAdminUserId,
        privateBucket: this.privateBucket,
        pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        expectedInputHash,
        expectedProjectPublicId,
      },
    );
  }
}
