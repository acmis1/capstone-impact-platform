import { z } from 'zod';

import {
  assistiveRecordableDispositionSchema,
  assistiveRunPersistenceInputSchema,
  assistivePipelineVersionSchema,
  storedAssistiveFindingSchema,
  storedAssistiveRunSchema,
  type AssistiveDisposition,
  type StoredAssistiveFinding,
  type StoredAssistiveRun,
} from '../domain/persistenceContract';
import type { AssistiveValidationPersistenceGateway } from '../repositories/assistiveValidationRepository';

/**
 * Application boundary for durable, non-authoritative assistive validation.
 *
 * This module deliberately imports nothing that can mutate authoritative workflow state: no
 * project metadata service, no review or approval action, no publication readiness or execution,
 * no archive or public removal, no Duda or public feed, and no Gemini or other model client.
 * Persisting a run, reading it back, and recording a reviewer disposition change no project state.
 *
 * The acting staff identity is always supplied by the caller from a verified server session. A
 * browser-provided staff UUID must never be forwarded here, and the database re-proves the actor's
 * role independently before it writes anything.
 */

export type AssistivePersistenceErrorCode =
  | 'VALIDATION_FAILED'
  | 'IDENTITY_CONFLICT'
  | 'PROJECT_NOT_FOUND'
  | 'FINDING_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PERSISTENCE_FAILED'
  | 'INTERNAL_FAILURE';

const MESSAGES: Record<AssistivePersistenceErrorCode, string> = {
  VALIDATION_FAILED: 'The assistive validation record did not satisfy the bounded persistence contract.',
  IDENTITY_CONFLICT: 'A durable result already exists for this content identity but does not match the submitted result.',
  PROJECT_NOT_FOUND: 'The project for this assistive validation record was not found.',
  FINDING_NOT_FOUND: 'The assistive finding was not found.',
  PERMISSION_DENIED: 'This staff account is not permitted to perform that assistive action.',
  PERSISTENCE_FAILED: 'The assistive validation record could not be stored.',
  INTERNAL_FAILURE: 'The assistive validation record could not be processed.',
};

export function assistivePersistenceMessage(code: AssistivePersistenceErrorCode): string {
  return MESSAGES[code];
}

export interface AssistivePersistenceFailure {
  ok: false;
  code: AssistivePersistenceErrorCode;
  message: string;
}

function failure(code: AssistivePersistenceErrorCode): AssistivePersistenceFailure {
  return { ok: false, code, message: MESSAGES[code] };
}

const actorSchema = z.uuid();

const persistedResultSchema = z.object({
  resultCode: z.literal('PERSISTED'),
  runId: z.uuid(),
  status: z.enum(['COMPLETED', 'FAILED']),
  findingCount: z.number().int().min(0),
}).strict().superRefine((result, context) => {
  if (result.status === 'COMPLETED' && result.findingCount === 0) {
    context.addIssue({ code: 'custom', message: 'A persisted completed run must contain findings.' });
  }
  if (result.status === 'FAILED' && result.findingCount !== 0) {
    context.addIssue({ code: 'custom', message: 'A persisted failed run must not contain findings.' });
  }
});

const persistResponseSchema = z.discriminatedUnion('resultCode', [
  persistedResultSchema,
  z.object({
    resultCode: z.literal('ALREADY_PERSISTED'),
    runId: z.uuid(),
    status: z.literal('COMPLETED'),
    findingCount: z.number().int().min(1),
  }).strict(),
  z.object({ resultCode: z.literal('IDENTITY_CONFLICT') }).strict(),
  z.object({ resultCode: z.literal('PROJECT_NOT_FOUND') }).strict(),
  z.object({ resultCode: z.literal('PERMISSION_DENIED') }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

const readResponseSchema = z.discriminatedUnion('resultCode', [
  z.object({
    resultCode: z.literal('FOUND'),
    run: storedAssistiveRunSchema,
    findings: z.array(storedAssistiveFindingSchema),
  }).strict(),
  z.object({ resultCode: z.literal('NOT_FOUND') }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

const dispositionSuccessShape = {
  findingId: z.uuid(),
  disposition: assistiveRecordableDispositionSchema,
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.string().min(1),
};

const dispositionResponseSchema = z.discriminatedUnion('resultCode', [
  z.object({ resultCode: z.literal('RECORDED'), ...dispositionSuccessShape }).strict(),
  z.object({ resultCode: z.literal('UNCHANGED'), ...dispositionSuccessShape }).strict(),
  z.object({ resultCode: z.literal('FINDING_NOT_FOUND') }).strict(),
  z.object({ resultCode: z.literal('PERMISSION_DENIED') }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

export type AssistiveRunPersistenceResult =
  | {
    ok: true;
    runId: string;
    status: 'COMPLETED' | 'FAILED';
    findingCount: number;
    /** True only when an identical completed finding set was already durable and returned unchanged. */
    alreadyPersisted: boolean;
  }
  | AssistivePersistenceFailure;

export type AssistiveRunReadResult =
  | { ok: true; found: false }
  | { ok: true; found: true; run: StoredAssistiveRun; findings: StoredAssistiveFinding[] }
  | AssistivePersistenceFailure;

export type AssistiveDispositionResult =
  | {
    ok: true;
    findingId: string;
    disposition: AssistiveDisposition;
    reviewedBy: string | null;
    reviewedAt: string;
    /** False when the finding already carried this disposition and nothing was rewritten. */
    changed: boolean;
  }
  | AssistivePersistenceFailure;

/** Bounded operational logging. The raw database error is never logged or returned. */
function logBoundedFailure(operation: string, error: unknown): void {
  const code = error instanceof Error ? error.message : 'UNKNOWN';
  console.error(`[Assistive persistence] ${operation}: ${/^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN'}`);
}

/**
 * Persists one terminal run and every one of its findings in a single database transaction. A
 * repeat attempt for an identical (project, input hash, pipeline version) converges on the run
 * that is already durable instead of duplicating findings or rewriting stored evidence.
 */
export async function persistAssistiveValidationRun(
  gateway: AssistiveValidationPersistenceGateway,
  rawInput: unknown,
  actorAdminUserId: string,
): Promise<AssistiveRunPersistenceResult> {
  const actor = actorSchema.safeParse(actorAdminUserId);
  if (!actor.success) return failure('VALIDATION_FAILED');

  const parsed = assistiveRunPersistenceInputSchema.safeParse(rawInput);
  if (!parsed.success) return failure('VALIDATION_FAILED');

  let raw: unknown;
  try {
    raw = await gateway.persistRun(parsed.data, actor.data);
  } catch (error) {
    logBoundedFailure('persistRun', error);
    return failure('PERSISTENCE_FAILED');
  }

  const response = persistResponseSchema.safeParse(raw);
  if (!response.success) return failure('INTERNAL_FAILURE');

  switch (response.data.resultCode) {
    case 'PERSISTED':
    case 'ALREADY_PERSISTED': {
      const { runId, status, findingCount } = response.data;
      if (!runId || !status || findingCount === undefined) return failure('INTERNAL_FAILURE');
      return {
        ok: true,
        runId,
        status,
        findingCount,
        alreadyPersisted: response.data.resultCode === 'ALREADY_PERSISTED',
      };
    }
    case 'PROJECT_NOT_FOUND': return failure('PROJECT_NOT_FOUND');
    case 'PERMISSION_DENIED': return failure('PERMISSION_DENIED');
    case 'VALIDATION_FAILED': return failure('VALIDATION_FAILED');
    case 'IDENTITY_CONFLICT': return failure('IDENTITY_CONFLICT');
  }
}

/**
 * Loads the latest durable run for one project and pipeline version. The result is re-parsed
 * against the same strict contract used on the way in, so a database row that no longer satisfies
 * it is reported as an internal failure rather than surfaced as trustworthy evidence.
 */
export async function loadLatestAssistiveValidationRun(
  gateway: AssistiveValidationPersistenceGateway,
  projectId: string,
  pipelineVersion: string,
): Promise<AssistiveRunReadResult> {
  const project = z.uuid().safeParse(projectId);
  const pipeline = assistivePipelineVersionSchema.safeParse(pipelineVersion);
  if (!project.success || !pipeline.success) return failure('VALIDATION_FAILED');

  let raw: unknown;
  try {
    raw = await gateway.loadLatestRun(project.data, pipeline.data);
  } catch (error) {
    logBoundedFailure('loadLatestRun', error);
    return failure('PERSISTENCE_FAILED');
  }

  const response = readResponseSchema.safeParse(raw);
  if (!response.success) return failure('INTERNAL_FAILURE');

  switch (response.data.resultCode) {
    case 'NOT_FOUND': return { ok: true, found: false };
    case 'VALIDATION_FAILED': return failure('VALIDATION_FAILED');
    case 'FOUND': {
      const { run, findings } = response.data;
      if (run.projectId !== project.data || run.pipelineVersion !== pipeline.data) {
        return failure('INTERNAL_FAILURE');
      }
      return { ok: true, found: true, run, findings };
    }
  }
}

/**
 * Records a reviewer disposition against one finding. The finding's evidence, outcome, reason, and
 * run ownership are untouched, and no project workflow state changes as a result.
 */
export async function recordAssistiveFindingDisposition(
  gateway: AssistiveValidationPersistenceGateway,
  findingId: string,
  actorAdminUserId: string,
  disposition: unknown,
): Promise<AssistiveDispositionResult> {
  const finding = z.uuid().safeParse(findingId);
  const actor = actorSchema.safeParse(actorAdminUserId);
  const requested = assistiveRecordableDispositionSchema.safeParse(disposition);
  if (!finding.success || !actor.success || !requested.success) return failure('VALIDATION_FAILED');

  let raw: unknown;
  try {
    raw = await gateway.recordDisposition(finding.data, actor.data, requested.data);
  } catch (error) {
    logBoundedFailure('recordDisposition', error);
    return failure('PERSISTENCE_FAILED');
  }

  const response = dispositionResponseSchema.safeParse(raw);
  if (!response.success) return failure('INTERNAL_FAILURE');

  switch (response.data.resultCode) {
    case 'RECORDED':
    case 'UNCHANGED': {
      const { findingId: id, disposition: stored, reviewedAt } = response.data;
      if (id !== finding.data || stored !== requested.data) return failure('INTERNAL_FAILURE');
      return {
        ok: true,
        findingId: id,
        disposition: stored,
        reviewedBy: response.data.reviewedBy ?? null,
        reviewedAt,
        changed: response.data.resultCode === 'RECORDED',
      };
    }
    case 'FINDING_NOT_FOUND': return failure('FINDING_NOT_FOUND');
    case 'PERMISSION_DENIED': return failure('PERMISSION_DENIED');
    case 'VALIDATION_FAILED': return failure('VALIDATION_FAILED');
  }
}
