import { describe, expect, it } from 'vitest';

import {
  assistiveInspectionResponseSchema,
  assistiveInspectionViewSchema,
  storedAssistiveInspectionRunSchema,
} from '../domain/inspectionContract';
import { ASSISTIVE_PIPELINE_VERSION } from '../domain/persistenceContract';

const RUN_ID = '33333333-3333-4333-8333-333333333333';
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

  it('validates discriminated union responses for FOUND, NOT_FOUND, and VALIDATION_FAILED', () => {
    const found = assistiveInspectionResponseSchema.safeParse({
      resultCode: 'FOUND',
      run: validRun(),
      findings: [],
    });
    expect(found.success).toBe(true);

    const notFound = assistiveInspectionResponseSchema.safeParse({ resultCode: 'NOT_FOUND' });
    expect(notFound.success).toBe(true);

    const validationFailed = assistiveInspectionResponseSchema.safeParse({ resultCode: 'VALIDATION_FAILED' });
    expect(validationFailed.success).toBe(true);
  });

  it('validates assistiveInspectionViewSchema with stale state', () => {
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
      findings: [],
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
