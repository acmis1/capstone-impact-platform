import { describe, expect, it, vi } from 'vitest';

import {
  deriveActualPreviewObservations,
  runReleaseEvaluation,
  runForcedFailureCleanupProbe,
  validateReleaseEvaluationRunNamespace,
  assertReleaseLocalTarget,
  assertCohortAccounting,
  readinessField,
  cleanupOwnedState,
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
  it.each(['https://localhost.example.com', 'https://127.0.0.1.example.com', 'https://127.0.0.1@host.example.com', 'ftp://127.0.0.1', 'http://127.0.0.1/forward', 'http://127.0.0.1?target=remote'])('refuses deceptive or non-HTTP target %s', (url) => {
    expect(() => assertReleaseLocalTarget(url)).toThrow('loopback');
  });

  it('verifies every actual client target, including the production staging singleton', () => {
    expect(() => assertReleaseLocalTarget('http://127.0.0.1:54321', ['https://example.supabase.co'])).toThrow('loopback');
    expect(() => assertReleaseLocalTarget('http://127.0.0.1:54321', ['http://127.0.0.1:54331'])).toThrow('match');
    expect(() => assertReleaseLocalTarget('http://[::1]:54321', ['http://[::1]:54321/'])).not.toThrow();
  });

  it('rejects dropped, duplicated, and substituted bulk results', () => {
    for (const result of [['a'], ['a', 'a'], ['a', 'foreign']]) expect(() => assertCohortAccounting(['a', 'b'], result)).toThrow();
    expect(() => assertCohortAccounting(['a', 'b'], ['b', 'a'])).not.toThrow();
    expect(readinessField('Poster full text is missing.')).toBe('posterText');
    expect(readinessField('Accessibility text is missing.')).toBe('accessibilityText');
  });
  it('refuses a non-loopback endpoint before touching the Supabase client', async () => {
    const supabase = {} as Parameters<typeof runReleaseEvaluation>[0]['supabase'];
    await expect(runReleaseEvaluation({ supabase, apiUrl: 'https://example.supabase.co' })).rejects.toThrow('loopback');
  });

  it('proves the tooling failure hook enters cleanup and leaves no residue', async () => {
    const createOwnedState = vi.fn(async () => undefined);
    const cleanupOwnedState = vi.fn(async () => ({ completed: true, residue: { projects: 0, media: 0, batches: 0 } }));
    const result = await runForcedFailureCleanupProbe({ createOwnedState, cleanupOwnedState });

    expect(createOwnedState).toHaveBeenCalledOnce();
    expect(cleanupOwnedState).toHaveBeenCalledOnce();
    expect(result).toEqual({ completed: true, residue: { projects: 0, media: 0, batches: 0 } });
  });

  it('does not certify a failed cleanup with zero visible residue', async () => {
    const result = await runForcedFailureCleanupProbe({ createOwnedState: async () => {}, cleanupOwnedState: async () => ({ completed: false, residue: { projects: 0 } }) });
    expect(result.completed).toBe(false);
  });

  it('continues cleanup after one deletion fails and never removes an unrelated media path', async () => {
    const deleted: string[] = [];
    const remove = vi.fn(async () => ({ error: null }));
    const client = {
      from: (table: string) => {
        let deleting = false;
        let head = false;
        const query = {
          select: (_columns: string, options?: { head?: boolean }) => { head = Boolean(options?.head); return query; },
          delete: () => { deleting = true; deleted.push(table); return query; },
          in: () => query,
          like: () => query,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve({
            data: deleting || head ? [] : table === 'projects' ? [{ id: 'owned-project' }]
              : table === 'media_assets' ? [{ storage_bucket: 'private', storage_path: 'drafts/ordinary-project/poster_image/poster.png' }] : [],
            error: deleting && table === 'approval_records' ? { code: 'injected-failure' } : null,
            count: 0,
          }).then(resolve),
        };
        return query;
      },
      storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove }) },
    } as unknown as Parameters<typeof cleanupOwnedState>[0];
    const result = await cleanupOwnedState(client, { privateBucket: 'private', ownedPublicIds: new Set(['release-run-1-0123456789abcdef-synthetic-001']), ownedBatchIds: new Set(['owned-batch']), ownedStoragePaths: new Set(), previewIds: new Set() });
    expect(result.completed).toBe(false);
    expect(deleted).toEqual(expect.arrayContaining(['approval_records', 'validation_flags', 'projects', 'import_batches']));
    expect(remove).not.toHaveBeenCalled();
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
