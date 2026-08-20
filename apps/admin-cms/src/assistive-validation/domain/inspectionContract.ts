import { z } from 'zod';

import {
  ASSISTIVE_JOB_FAILURE_CODES,
  ASSISTIVE_JOB_STATUSES,
  ASSISTIVE_RUN_STATUSES,
} from './jobContract';
import {
  assistiveInputHashSchema,
  assistivePipelineVersionSchema,
  storedAssistiveFindingSchema,
} from './persistenceContract';

export const ASSISTIVE_STALE_STATES = ['CURRENT', 'STALE', 'UNVERIFIABLE'] as const;
export type AssistiveStaleState = (typeof ASSISTIVE_STALE_STATES)[number];
export const assistiveStaleStateSchema = z.enum(ASSISTIVE_STALE_STATES);

export const storedAssistiveInspectionRunSchema = z.object({
  runId: z.uuid(),
  projectId: z.uuid(),
  inputHash: assistiveInputHashSchema,
  pipelineVersion: assistivePipelineVersionSchema,
  runStatus: z.enum(ASSISTIVE_RUN_STATUSES),
  jobStatus: z.enum(ASSISTIVE_JOB_STATUSES),
  attemptCount: z.number().int().min(0).max(2),
  failureCode: z.enum(ASSISTIVE_JOB_FAILURE_CODES).nullable(),
  cancellationRequested: z.boolean(),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable(),
  completedAt: z.string().min(1).nullable(),
}).strict();

export type StoredAssistiveInspectionRun = z.infer<typeof storedAssistiveInspectionRunSchema>;

export const assistiveInspectionResponseSchema = z.discriminatedUnion('resultCode', [
  z.object({
    resultCode: z.literal('FOUND'),
    run: storedAssistiveInspectionRunSchema,
    findings: z.array(storedAssistiveFindingSchema),
  }).strict(),
  z.object({ resultCode: z.literal('NOT_FOUND') }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

export type AssistiveInspectionResponse = z.infer<typeof assistiveInspectionResponseSchema>;

export const assistiveInspectionViewSchema = z.object({
  runId: z.uuid(),
  runStatus: z.enum(ASSISTIVE_RUN_STATUSES),
  jobStatus: z.enum(ASSISTIVE_JOB_STATUSES),
  attemptCount: z.number().int().min(0).max(2),
  failureCode: z.enum(ASSISTIVE_JOB_FAILURE_CODES).nullable(),
  cancellationRequested: z.boolean(),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable(),
  completedAt: z.string().min(1).nullable(),
  findings: z.array(storedAssistiveFindingSchema),
  staleState: assistiveStaleStateSchema,
}).strict();

export type AssistiveInspectionView = z.infer<typeof assistiveInspectionViewSchema>;
