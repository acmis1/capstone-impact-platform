import { describe, expect, it, vi } from 'vitest';

import {
  deriveActualPreviewObservations,
  runReleaseEvaluation,
  runForcedFailureCleanupProbe,
  validateReleaseEvaluationRunNamespace,
} from './releaseEvaluationHarness';
import { buildReleaseEvaluationCorpus } from '../fixtures/releaseEvaluationCorpus';
import {
  createReleaseEvidenceLedger,
  deriveFailureStageDistribution,
  evaluateReleaseAccounting,
  recordReleaseObservation,
} from './releaseEvaluationReport';

function previewPackage(overrides: Partial<Parameters<typeof deriveActualPreviewObservations>[1]> = {}) {
  return {
    status: 'invalid' as const,
    reconciliation: undefined,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe('release evaluation harness safety', () => {
  it('refuses a non-loopback endpoint before touching the Supabase client', async () => {
    const supabase = {} as Parameters<typeof runReleaseEvaluation>[0]['supabase'];
    await expect(runReleaseEvaluation({ supabase, apiUrl: 'https://example.supabase.co' })).rejects.toThrow('loopback');
  });

  it('proves the tooling failure hook enters cleanup and leaves no residue', async () => {
    const createOwnedState = vi.fn(async () => undefined);
    const cleanupOwnedState = vi.fn(async () => ({ projects: 0, media: 0, batches: 0 }));
    const result = await runForcedFailureCleanupProbe({ createOwnedState, cleanupOwnedState });

    expect(createOwnedState).toHaveBeenCalledOnce();
    expect(cleanupOwnedState).toHaveBeenCalledOnce();
    expect(result).toEqual({ completed: true, residue: { projects: 0, media: 0, batches: 0 } });
  });

  it('accepts only evaluator-generated namespaces for interrupted-run cleanup', () => {
    expect(() => validateReleaseEvaluationRunNamespace('run-1-0123456789abcdef')).not.toThrow();
    expect(() => validateReleaseEvaluationRunNamespace('run-2-fedcba9876543210')).not.toThrow();
    expect(() => validateReleaseEvaluationRunNamespace('release-anything')).toThrow('exact namespace');
    expect(() => validateReleaseEvaluationRunNamespace('run-1-../unsafe')).toThrow('exact namespace');
  });

  it('preserves an actual replacement code and reports the expected-code mismatch', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'xlsx-missing-title');
    if (!expectedCase) throw new Error('Missing expected-code test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    const observations = deriveActualPreviewObservations(expectedCase.caseId, previewPackage({
      errors: [{ code: 'WORKBOOK_ACTUAL_CODE_B', message: 'Actual parser reason.', severity: 'error' }],
    }));
    observations.forEach((observation) => recordReleaseObservation(ledger, observation));

    expect(ledger.entries.get(expectedCase.caseId)?.terminalReasonCode).toBe('WORKBOOK_ACTUAL_CODE_B');
    expect(evaluateReleaseAccounting(ledger).expectedActualMismatchCaseIds).toContain(expectedCase.caseId);
  });

  it('keeps an absent actual code absent and reports the mismatch', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'xlsx-missing-title');
    if (!expectedCase) throw new Error('Missing expected-code test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    recordReleaseObservation(ledger, { caseId: expectedCase.caseId, stage: 'parse', outcome: 'rejected' });

    expect(ledger.entries.get(expectedCase.caseId)?.terminalReasonCode).toBeUndefined();
    expect(evaluateReleaseAccounting(ledger).expectedActualMismatchCaseIds).toContain(expectedCase.caseId);
  });

  it('keeps a staging failure as the actual stage when the manifest expects package validation', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'missing-poster-image');
    if (!expectedCase) throw new Error('Missing package-failure test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    recordReleaseObservation(ledger, { caseId: expectedCase.caseId, stage: 'metadata-staging', outcome: 'rejected', code: 'LOOKUP_NOT_FOUND', persisted: false });

    expect(ledger.entries.get(expectedCase.caseId)?.terminalFailureStage).toBe('metadata-staging');
    expect(deriveFailureStageDistribution({ ...corpus, cases: [expectedCase] }, ledger).actual).toEqual({ 'metadata-staging': 1 });
  });

  it('records unexpected persistence as actual persistence and fails accounting', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'missing-poster-image');
    if (!expectedCase) throw new Error('Missing persistence test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    recordReleaseObservation(ledger, { caseId: expectedCase.caseId, stage: 'final-persistence', outcome: 'accepted', persisted: true });

    const accounting = evaluateReleaseAccounting(ledger);
    expect(deriveFailureStageDistribution({ ...corpus, cases: [expectedCase] }, ledger).actual).toEqual({ persisted: 1 });
    expect(accounting.unexpectedPersistenceCaseIds).toContain(expectedCase.caseId);
    expect(accounting.expectedActualMismatchCaseIds).toContain(expectedCase.caseId);
  });
});
