import { z } from 'zod';

import {
  assistiveInspectionResponseSchema,
  assistiveInspectionViewSchema,
  type AssistiveInspectionView,
  type AssistiveStaleState,
} from '../domain/inspectionContract';
import {
  ASSISTIVE_PIPELINE_VERSION,
  assistivePipelineVersionSchema,
} from '../domain/persistenceContract';
import type { AssistiveInputGateway } from '../repositories/assistiveInputRepository';
import type { AssistiveValidationPersistenceGateway } from '../repositories/assistiveValidationRepository';
import { loadAssistiveInput } from './assistiveInputService';

const uuid = z.uuid();

export type AssistiveInspectionReadResult =
  | { ok: true; found: false }
  | { ok: true; found: true; inspection: AssistiveInspectionView }
  | { ok: false; code: 'VALIDATION_FAILED' | 'PERSISTENCE_FAILED' | 'INTERNAL_FAILURE'; message: string };

export async function loadAssistiveInspection(
  gateway: AssistiveValidationPersistenceGateway,
  inputGateway: AssistiveInputGateway,
  params: {
    projectId: string;
    pipelineVersion?: string;
    runId?: string;
    privateBucket: string;
  },
): Promise<AssistiveInspectionReadResult> {
  const parsed = z.object({
    projectId: uuid,
    pipelineVersion: assistivePipelineVersionSchema.default(ASSISTIVE_PIPELINE_VERSION),
    runId: uuid.optional(),
    privateBucket: z.string().min(1).max(100),
  }).strict().safeParse(params);

  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'The assistive inspection query parameters did not satisfy the bounded contract.',
    };
  }

  let raw: unknown;
  try {
    raw = await gateway.loadInspection(
      parsed.data.projectId,
      parsed.data.pipelineVersion,
      parsed.data.runId,
    );
  } catch (error) {
    console.error('[Assistive inspection service] loadInspection failure:', error instanceof Error ? error.message : 'UNKNOWN');
    return {
      ok: false,
      code: 'PERSISTENCE_FAILED',
      message: 'The assistive validation record could not be loaded.',
    };
  }

  const response = assistiveInspectionResponseSchema.safeParse(raw);
  if (!response.success) {
    return {
      ok: false,
      code: 'INTERNAL_FAILURE',
      message: 'The assistive validation record response was invalid.',
    };
  }

  if (response.data.resultCode === 'NOT_FOUND') {
    return { ok: true, found: false };
  }

  if (response.data.resultCode === 'VALIDATION_FAILED') {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'The database rejected the assistive inspection query parameters.',
    };
  }

  const { run, findings } = response.data;
  let staleState: AssistiveStaleState = 'CURRENT';

  // For active in-flight jobs, polling must remain cheap; skip heavy poster downloads.
  // For terminal jobs, compute current-input equality to verify stale status.
  const isTerminal = ['PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(run.runStatus);
  if (isTerminal) {
    try {
      const snapshot = await loadAssistiveInput(
        inputGateway,
        parsed.data.projectId,
        parsed.data.privateBucket,
      );
      if (!snapshot) {
        staleState = 'UNVERIFIABLE';
      } else if (snapshot.inputHash === run.inputHash) {
        staleState = 'CURRENT';
      } else {
        staleState = 'STALE';
      }
    } catch {
      staleState = 'UNVERIFIABLE';
    }
  }

  const view = assistiveInspectionViewSchema.safeParse({
    runId: run.runId,
    runStatus: run.runStatus,
    jobStatus: run.jobStatus,
    attemptCount: run.attemptCount,
    failureCode: run.failureCode,
    cancellationRequested: run.cancellationRequested,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    findings,
    staleState,
  });

  if (!view.success) {
    return {
      ok: false,
      code: 'INTERNAL_FAILURE',
      message: 'The assistive inspection view model could not be constructed.',
    };
  }

  return {
    ok: true,
    found: true,
    inspection: view.data,
  };
}
