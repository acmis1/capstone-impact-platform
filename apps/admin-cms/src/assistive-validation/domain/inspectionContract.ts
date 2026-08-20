import { z } from 'zod';

import {
  ASSISTIVE_JOB_FAILURE_CODES,
  ASSISTIVE_JOB_STATUSES,
  ASSISTIVE_RUN_STATUSES,
} from './jobContract';
import {
  ASSISTIVE_DISPOSITIONS,
  ASSISTIVE_PERSISTENCE_LIMITS,
  assistiveInputHashSchema,
  assistivePipelineVersionSchema,
  persistedAssistiveEvidenceSchema,
  postgresCanonicalUuidSchema,
} from './persistenceContract';
import { assistiveCheckResultSchema } from './evidence';

export const ASSISTIVE_STALE_STATES = ['CURRENT', 'STALE', 'UNVERIFIABLE'] as const;
export type AssistiveStaleState = (typeof ASSISTIVE_STALE_STATES)[number];
export const assistiveStaleStateSchema = z.enum(ASSISTIVE_STALE_STATES);

const checkResultShape = assistiveCheckResultSchema.shape;

/**
 * Browser-safe finding contract.
 *
 * Privacy Invariant: internal staff identity UUIDs (e.g. reviewedBy) are strictly omitted
 * from the browser-facing contract. Strict parsing rejects any payload carrying unexpected fields.
 */
export const assistiveInspectionFindingSchema = z.object({
  findingId: z.uuid(),
  ordinal: z.number().int().min(1).max(ASSISTIVE_PERSISTENCE_LIMITS.findingsPerRun),
  checkType: checkResultShape.checkType,
  outcome: checkResultShape.outcome,
  classification: checkResultShape.classification,
  reasonCode: checkResultShape.reasonCode,
  affectedField: checkResultShape.affectedField,
  origin: checkResultShape.origin,
  scoreKind: z.literal('LEXICAL_SIMILARITY').nullable(),
  scoreValue: z.number().finite().min(0).max(1).nullable(),
  evidence: persistedAssistiveEvidenceSchema,
  disposition: z.enum(ASSISTIVE_DISPOSITIONS),
  reviewedAt: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
}).strict().superRefine((finding, context) => {
  if ((finding.scoreKind === null) !== (finding.scoreValue === null)) {
    context.addIssue({ code: 'custom', message: 'Score kind and value must both be present or both absent.' });
  }
  if (finding.disposition === 'UNREVIEWED' && finding.reviewedAt !== null) {
    context.addIssue({ code: 'custom', message: 'An unreviewed finding must not claim review timestamp.' });
  }
});

export type AssistiveInspectionFinding = z.infer<typeof assistiveInspectionFindingSchema>;

export const storedAssistiveInspectionRunSchema = z.object({
  runId: z.uuid(),
  projectId: postgresCanonicalUuidSchema,
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
    findings: z.array(assistiveInspectionFindingSchema).max(ASSISTIVE_PERSISTENCE_LIMITS.findingsPerRun),
  }).strict(),
  z.object({ resultCode: z.literal('NOT_FOUND') }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
  z.object({ resultCode: z.literal('INVARIANT_VIOLATION') }).strict(),
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
  findings: z.array(assistiveInspectionFindingSchema).max(ASSISTIVE_PERSISTENCE_LIMITS.findingsPerRun),
  staleState: assistiveStaleStateSchema,
}).strict();

export type AssistiveInspectionView = z.infer<typeof assistiveInspectionViewSchema>;
