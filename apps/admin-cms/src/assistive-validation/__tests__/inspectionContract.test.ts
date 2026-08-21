import { describe, expect, it } from 'vitest';

import {
  assistiveInspectionFindingSchema,
  assistiveInspectionResponseSchema,
  assistiveInspectionViewSchema,
  storedAssistiveInspectionRunSchema,
} from '../domain/inspectionContract';
import { ASSISTIVE_PIPELINE_VERSION } from '../domain/persistenceContract';

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const FINDING_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const INPUT_HASH = 'a'.repeat(64);
const CREATED_AT = '2026-08-21T09:00:00.000Z';

const validRun = () => ({
  runId: RUN_ID,
  projectId: PROJECT_ID,
  inputHash: INPUT_HASH,
  pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
  runStatus: 'COMPLETED' as const,
  jobStatus: 'COMPLETED' as const,
  attemptCount: 1,
  failureCode: null,
  cancellationRequested: false,
  createdAt: CREATED_AT,
  startedAt: CREATED_AT,
  completedAt: CREATED_AT,
});

const validFinding = (ordinal = 1) => ({
  findingId: FINDING_ID,
  ordinal,
  checkType: 'TITLE_CONSISTENCY' as const,
  outcome: 'MISMATCH' as const,
  classification: 'NON_BLOCKING' as const,
  reasonCode: 'MATERIAL_TOKEN_DIFFERENCE',
  affectedField: 'title' as const,
  origin: 'DETERMINISTIC_HELPER' as const,
  scoreKind: 'LEXICAL_SIMILARITY' as const,
  scoreValue: 0.42,
  evidence: {
    version: 'assistive-finding-evidence/v1' as const,
    evidenceExcerpt: 'Synthetic Excerpt',
    pageNumber: 1,
    boundingBox: null,
    metadataValue: 'Synthetic Project',
    normalizedMetadataValue: 'synthetic project',
    candidateValue: 'Candidate Poster Title',
    normalizedCandidateValue: 'candidate poster title',
    explanation: 'Synthetic candidate explanation.',
  },
  disposition: 'UNREVIEWED' as const,
  createdAt: CREATED_AT,
});

const duplicateFinding = () => ({
  ...validFinding(),
  checkType: 'DUPLICATE_SHORTLIST' as const,
  outcome: 'INFORMATION' as const,
  reasonCode: 'LEXICAL_DUPLICATE_SHORTLIST' as const,
  affectedField: 'project_content' as const,
  scoreKind: null,
  scoreValue: null,
  evidence: {
    version: 'assistive-finding-evidence/v2' as const,
    evidenceExcerpt: null,
    pageNumber: null,
    boundingBox: null,
    metadataValue: null,
    normalizedMetadataValue: null,
    candidateValue: null,
    normalizedCandidateValue: null,
    explanation: 'Staff review similar projects.',
    duplicateCandidates: [{
      rank: 1,
      publicId: '2026-similar-project',
      title: 'Similar Project',
      summaryExcerpt: 'A bounded excerpt.',
      lexicalScore: 0.85,
      exactContentMatch: false,
      normalizedTitleMatch: false,
    }],
  },
});

describe('inspectionContract schemas', () => {
  it('validates a complete storedAssistiveInspectionRunSchema', () => {
    const parsed = storedAssistiveInspectionRunSchema.safeParse(validRun());
    expect(parsed.success).toBe(true);
  });

  it('rejects extra unallowed properties in storedAssistiveInspectionRunSchema (strict mode)', () => {
    const invalid = { ...validRun(), claimToken: 'secret', workerId: 'worker-1' };
    const parsed = storedAssistiveInspectionRunSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });

  it('validates assistiveInspectionFindingSchema and rejects reviewer identity and timestamps', () => {
    const finding = validFinding();
    const validParsed = assistiveInspectionFindingSchema.safeParse(finding);
    expect(validParsed.success).toBe(true);

    const withReviewer = { ...finding, reviewedBy: '55555555-5555-4555-8555-555555555555' };
    expect(assistiveInspectionFindingSchema.safeParse(withReviewer).success).toBe(false);

    const withReviewTimestamp = { ...finding, reviewedAt: CREATED_AT };
    expect(assistiveInspectionFindingSchema.safeParse(withReviewTimestamp).success).toBe(false);
  });

  it('round-trips strict browser-safe duplicate evidence without private identifiers', () => {
    expect(assistiveInspectionFindingSchema.safeParse(duplicateFinding()).success).toBe(true);
    const candidate = duplicateFinding().evidence.duplicateCandidates[0];
    expect(assistiveInspectionFindingSchema.safeParse({
      ...duplicateFinding(),
      evidence: {
        ...duplicateFinding().evidence,
        duplicateCandidates: [{ ...candidate, projectId: PROJECT_ID }],
      },
    }).success).toBe(false);
  });

  it('validates discriminated union responses for FOUND, NOT_FOUND, VALIDATION_FAILED, and INVARIANT_VIOLATION', () => {
    const found = assistiveInspectionResponseSchema.safeParse({
      resultCode: 'FOUND',
      run: validRun(),
      findings: [validFinding()],
    });
    expect(found.success).toBe(true);

    const notFound = assistiveInspectionResponseSchema.safeParse({ resultCode: 'NOT_FOUND' });
    expect(notFound.success).toBe(true);

    const validationFailed = assistiveInspectionResponseSchema.safeParse({ resultCode: 'VALIDATION_FAILED' });
    expect(validationFailed.success).toBe(true);

    const invariantViolation = assistiveInspectionResponseSchema.safeParse({ resultCode: 'INVARIANT_VIOLATION' });
    expect(invariantViolation.success).toBe(true);
  });

  it('enforces maximum 50 findings bound at contract level (50 passes, 51 fails)', () => {
    const fiftyFindings = Array.from({ length: 50 }, (_, i) => validFinding(i + 1));
    const fiftyResult = assistiveInspectionResponseSchema.safeParse({
      resultCode: 'FOUND',
      run: validRun(),
      findings: fiftyFindings,
    });
    expect(fiftyResult.success).toBe(true);

    const fiftyOneFindings = Array.from({ length: 51 }, (_, i) => validFinding(i + 1));
    const fiftyOneResult = assistiveInspectionResponseSchema.safeParse({
      resultCode: 'FOUND',
      run: validRun(),
      findings: fiftyOneFindings,
    });
    expect(fiftyOneResult.success).toBe(false);
  });

  it('validates assistiveInspectionViewSchema with stale state and bounds', () => {
    const run = validRun();
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
      findings: [validFinding()],
      staleState: 'CURRENT',
    });
    expect(view.success).toBe(true);
  });

  it('rejects an invalid stale state in assistiveInspectionViewSchema', () => {
    const view = assistiveInspectionViewSchema.safeParse({
      ...validRun(),
      findings: [],
      staleState: 'INVALID_STALE_STATE',
    });
    expect(view.success).toBe(false);
  });
});
