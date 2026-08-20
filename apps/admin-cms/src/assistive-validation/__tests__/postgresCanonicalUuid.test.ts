import { describe, expect, it } from 'vitest';

import {
  assistiveClaimSchema,
  assistiveFinalizeInputSchema,
  assistiveStatusResponseSchema,
} from '../domain/jobContract';
import {
  ASSISTIVE_PIPELINE_VERSION,
  assistiveRunPersistenceInputSchema,
  postgresCanonicalUuidSchema,
  storedAssistiveFindingSchema,
  toPersistedAssistiveFinding,
} from '../domain/persistenceContract';
import { storedAssistiveInspectionRunSchema } from '../domain/inspectionContract';
import { createAssistiveCheckResult } from '../domain/evidence';


/**
 * The repository seeds synthetic projects and media with canonical UUID text that carries no RFC
 * 9562 version nibble, because PostgreSQL's `uuid` type does not require one. Zod's `z.uuid()` does.
 * Every staff-facing assistive path resolves `projects.id` straight out of the database, so parsing
 * a project identifier with `z.uuid()` failed every seeded project closed before it ever reached a
 * query. These tests pin which boundaries were widened to accept a database row identifier and,
 * just as importantly, which were deliberately left strict.
 */
describe('assistive UUID boundaries', () => {
  /** Shapes taken from `infra/supabase/seed.sql`: projects `e0000000-...`, media `f0000000-...`. */
  const SEEDED_PROJECT_ID = 'e0000000-0000-0000-0000-000000000001';
  const SEEDED_MEDIA_ID = 'f0000000-0000-0000-0000-000000000001';
  /** Anything the database generates with `gen_random_uuid()` is a version 4 UUID. */
  const GENERATED_ID = '33333333-3333-4333-8333-333333333333';
  const INPUT_HASH = 'a'.repeat(64);
  const CREATED_AT = '2026-08-21T09:00:00.000Z';

  it('accepts canonical database UUID text that carries no RFC version nibble', () => {
    for (const id of [SEEDED_PROJECT_ID, SEEDED_MEDIA_ID, GENERATED_ID]) {
      expect(postgresCanonicalUuidSchema.safeParse(id).success).toBe(true);
    }
  });

  it('still rejects text that is not canonical UUID form', () => {
    for (const invalid of [
      '',
      'not-a-uuid',
      'e0000000-0000-0000-0000-00000000000',
      'e0000000-0000-0000-0000-0000000000011',
      'g0000000-0000-0000-0000-000000000001',
      'e0000000000000000000000000000001',
      ` ${SEEDED_PROJECT_ID}`,
    ]) {
      expect(postgresCanonicalUuidSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('parses a seeded project identifier at every boundary that carries one', () => {
    expect(assistiveRunPersistenceInputSchema.safeParse({
      projectId: SEEDED_PROJECT_ID,
      inputHash: INPUT_HASH,
      pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      status: 'FAILED',
      failureCode: 'EXTRACTION_FAILED',
      findings: [],
    }).success).toBe(true);

    expect(assistiveStatusResponseSchema.safeParse({
      resultCode: 'FOUND',
      runId: GENERATED_ID,
      projectId: SEEDED_PROJECT_ID,
      inputHash: INPUT_HASH,
      pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      runStatus: 'QUEUED',
      jobStatus: 'QUEUED',
      attemptCount: 0,
      failureCode: null,
      cancellationRequested: false,
      createdAt: CREATED_AT,
      startedAt: null,
      completedAt: null,
    }).success).toBe(true);

    expect(storedAssistiveInspectionRunSchema.safeParse({
      runId: GENERATED_ID,
      projectId: SEEDED_PROJECT_ID,
      inputHash: INPUT_HASH,
      pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      runStatus: 'COMPLETED',
      jobStatus: 'COMPLETED',
      attemptCount: 1,
      failureCode: null,
      cancellationRequested: false,
      createdAt: CREATED_AT,
      startedAt: CREATED_AT,
      completedAt: CREATED_AT,
    }).success).toBe(true);
  });

  /**
   * The claim token is the Phase 4 fencing token: a worker proves it still owns a lease by
   * presenting it. Widening the shape it accepts is a security change, not a convenience one, so it
   * stays on `z.uuid()` even though it sits beside project identifiers that were widened.
   */
  it('keeps the job claim token strict', () => {
    const claim = {
      resultCode: 'CLAIMED' as const,
      jobId: GENERATED_ID,
      runId: GENERATED_ID,
      projectId: SEEDED_PROJECT_ID,
      requestedBy: GENERATED_ID,
      inputHash: INPUT_HASH,
      pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      attemptCount: 1,
      claimToken: GENERATED_ID,
      leaseUntil: CREATED_AT,
    };
    expect(assistiveClaimSchema.safeParse(claim).success).toBe(true);
    expect(assistiveClaimSchema.safeParse({ ...claim, claimToken: SEEDED_PROJECT_ID }).success).toBe(false);
    expect(assistiveClaimSchema.safeParse({ ...claim, jobId: SEEDED_PROJECT_ID }).success).toBe(false);

    const finalize = {
      jobId: GENERATED_ID,
      claimToken: GENERATED_ID,
      inputHash: INPUT_HASH,
      status: 'COMPLETED' as const,
      completionCode: null,
      findings: [],
    };
    expect(assistiveFinalizeInputSchema.safeParse({ ...finalize, claimToken: SEEDED_PROJECT_ID }).success).toBe(false);
  });

  /** Findings and reviewer attribution are database-generated, so they stay strict too. */
  it("keeps database-generated finding and reviewer identifiers strict", () => {
    const storedFinding = {
      findingId: GENERATED_ID,
      ordinal: 1,
      ...toPersistedAssistiveFinding(createAssistiveCheckResult({
        checkType: "TITLE_CONSISTENCY",
        outcome: "REVIEW",
        classification: "NON_BLOCKING",
        reasonCode: "POSSIBLE_OCR_OR_SPELLING_VARIANT",
        affectedField: "title",
        origin: "PHASE_1_EXTRACTION",
        evidenceExcerpt: "F1ood Resilience Mapping",
        pageNumber: 1,
        boundingBox: { left: 10, top: 20, right: 300, bottom: 60, unit: "PDF_POINTS_TOP_LEFT" },
        metadataValue: "Flood Resilience Mapping",
        normalizedMetadataValue: "flood resilience mapping",
        candidateValue: "F1ood Resilience Mapping",
        normalizedCandidateValue: "f1ood resilience mapping",
        lexicalScore: 0.95,
        explanation: "Title is not an exact normalized match and may reflect OCR variation.",
      })),
      disposition: "UNREVIEWED" as const,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: CREATED_AT,
    };
    expect(storedAssistiveFindingSchema.safeParse(storedFinding).success).toBe(true);
    expect(storedAssistiveFindingSchema.safeParse({
      ...storedFinding, findingId: SEEDED_PROJECT_ID,
    }).success).toBe(false);
    expect(storedAssistiveFindingSchema.safeParse({
      ...storedFinding, disposition: "REVIEWED", reviewedBy: SEEDED_PROJECT_ID, reviewedAt: CREATED_AT,
    }).success).toBe(false);
    expect(storedAssistiveFindingSchema.safeParse({
      ...storedFinding, disposition: "REVIEWED", reviewedBy: GENERATED_ID, reviewedAt: CREATED_AT,
    }).success).toBe(true);
  });
});
