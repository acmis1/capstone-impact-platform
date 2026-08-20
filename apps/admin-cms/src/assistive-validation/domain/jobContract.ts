import { z } from 'zod';

import { phase1ExtractionResultSchema } from './extractionContract';
import {
  assistiveInputHashSchema,
  assistivePipelineVersionSchema,
  persistedAssistiveFindingSchema,
} from './persistenceContract';

export const ASSISTIVE_RUN_STATUSES = [
  'QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
] as const;
export const ASSISTIVE_JOB_STATUSES = [
  'QUEUED', 'EXTRACTING', 'CHECKING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
] as const;
export const ASSISTIVE_JOB_FAILURE_CODES = [
  'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
  'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
  'DETERMINISTIC_CONTRACT_REJECTED', 'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE',
  'IDENTITY_CONFLICT', 'INTERNAL_FAILURE',
] as const;

export type AssistiveRunStatus = (typeof ASSISTIVE_RUN_STATUSES)[number];
export type AssistiveJobStatus = (typeof ASSISTIVE_JOB_STATUSES)[number];
export type AssistiveJobFailureCode = (typeof ASSISTIVE_JOB_FAILURE_CODES)[number];

const timestamp = z.string().min(1);
const runStatus = z.enum(ASSISTIVE_RUN_STATUSES);
const jobStatus = z.enum(ASSISTIVE_JOB_STATUSES);
const failureCode = z.enum(ASSISTIVE_JOB_FAILURE_CODES);

export const assistiveClaimSchema = z.discriminatedUnion('resultCode', [
  z.object({ resultCode: z.literal('EMPTY') }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
  z.object({
    resultCode: z.literal('CLAIMED'),
    jobId: z.uuid(),
    runId: z.uuid(),
    projectId: z.uuid(),
    requestedBy: z.uuid().nullable(),
    inputHash: assistiveInputHashSchema,
    pipelineVersion: assistivePipelineVersionSchema,
    attemptCount: z.number().int().min(1).max(2),
    claimToken: z.uuid(),
    leaseUntil: timestamp,
  }).strict(),
]);

export type AssistiveClaim = Extract<z.infer<typeof assistiveClaimSchema>, { resultCode: 'CLAIMED' }>;

export const assistiveEnqueueResponseSchema = z.discriminatedUnion('resultCode', [
  z.object({
    resultCode: z.enum(['ENQUEUED', 'ALREADY_QUEUED', 'ALREADY_COMPLETED']),
    runId: z.uuid(),
    status: runStatus,
  }).strict(),
  z.object({ resultCode: z.enum(['VALIDATION_FAILED', 'PERMISSION_DENIED', 'PROJECT_NOT_FOUND']) }).strict(),
]);

export const assistiveStatusResponseSchema = z.discriminatedUnion('resultCode', [
  z.object({ resultCode: z.enum(['NOT_FOUND', 'VALIDATION_FAILED']) }).strict(),
  z.object({
    resultCode: z.literal('FOUND'),
    runId: z.uuid(),
    projectId: z.uuid(),
    inputHash: assistiveInputHashSchema,
    pipelineVersion: assistivePipelineVersionSchema,
    runStatus,
    jobStatus,
    attemptCount: z.number().int().min(0).max(2),
    failureCode: failureCode.nullable(),
    cancellationRequested: z.boolean(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
  }).strict(),
]);

export const assistiveHealthResponseSchema = z.object({
  resultCode: z.literal('HEALTHY'),
  queuedCount: z.number().int().min(0),
  activeCount: z.number().int().min(0),
  expiredLeaseCount: z.number().int().min(0),
  cancellationPendingCount: z.number().int().min(0),
  oldestQueuedAt: timestamp.nullable(),
}).strict();

export const assistiveMutationResponseSchema = z.object({
  resultCode: z.literal('HEARTBEAT'),
  leaseUntil: timestamp,
}).strict().or(z.object({
  resultCode: z.literal('ADVANCED'),
  jobStatus: z.literal('CHECKING'),
}).strict()).or(z.object({
  resultCode: z.literal('CANCELLED'),
  jobStatus: z.literal('CANCELLED').optional(),
}).strict()).or(z.object({
  resultCode: z.literal('ALREADY_TERMINAL'),
  jobStatus: z.enum(['PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED']),
}).strict()).or(z.object({
  resultCode: z.literal('RETRY_QUEUED'),
  attemptCount: z.number().int().min(1).max(2),
}).strict()).or(z.object({
  resultCode: z.literal('FAILED'),
  failureCode,
}).strict()).or(z.object({
  resultCode: z.literal('FINALIZED'),
  runId: z.uuid(),
  status: z.enum(['COMPLETED', 'PARTIAL']),
  findingCount: z.number().int().min(1).max(50),
}).strict()).or(z.object({
  resultCode: z.literal('ALREADY_COMPLETED'),
  runId: z.uuid(),
  status: z.literal('COMPLETED'),
  findingCount: z.number().int().min(1).max(50),
}).strict()).or(z.object({
  resultCode: z.enum([
    'CANCELLATION_REQUESTED', 'SUPERSEDED', 'IDENTITY_CONFLICT', 'INPUT_CHANGED',
    'CLAIM_LOST', 'NOT_FOUND', 'PERMISSION_DENIED', 'VALIDATION_FAILED',
  ]),
}).strict());

export const assistiveFinalizeInputSchema = z.object({
  jobId: z.uuid(),
  claimToken: z.uuid(),
  inputHash: assistiveInputHashSchema,
  status: z.enum(['COMPLETED', 'PARTIAL']),
  completionCode: z.enum(['OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE']).nullable(),
  findings: z.array(persistedAssistiveFindingSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  if ((value.status === 'COMPLETED') !== (value.completionCode === null)) {
    context.addIssue({ code: 'custom', message: 'Completion status and code are incoherent.' });
  }
});

export const workerTaskResultSchema = z.object({
  schema_version: z.literal('assistive-worker-task-result/v1'),
  task_id: z.uuid().nullable(),
  extraction: phase1ExtractionResultSchema.nullable(),
  error: z.object({
    code: z.enum(['TASK_CONTRACT_REJECTED', 'TASK_EXECUTION_FAILED']),
    message: z.string().min(1).max(300),
  }).strict().nullable(),
  duration_ms: z.number().int().min(0).max(600_000),
}).strict().superRefine((value, context) => {
  if ((value.extraction === null) === (value.error === null)) {
    context.addIssue({ code: 'custom', message: 'Worker result requires exactly one result branch.' });
  }
});

export type WorkerTaskResult = z.infer<typeof workerTaskResultSchema>;
