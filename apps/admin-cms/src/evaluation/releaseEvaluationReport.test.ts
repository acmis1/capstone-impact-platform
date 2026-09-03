import { describe, expect, it } from 'vitest';

import {
  buildReleaseEvaluationCorpus,
} from '../fixtures/releaseEvaluationCorpus';
import {
  createReleaseEvaluationReport,
  createReleaseEvidenceLedger,
  compareNormalizedReleaseReports,
  deriveSeededIssueMetrics,
  deriveFailureStageDistribution,
  evaluateReleaseAccounting,
  evaluateReleaseGate,
  recordReleaseObservation,
  renderReleaseEvaluationJson,
  renderReleaseEvaluationMarkdown,
  summarizeReleaseTimings,
} from './releaseEvaluationReport';

function expectedRejectedStage(item: ReturnType<typeof buildReleaseEvaluationCorpus>['cases'][number]): 'parse' | 'package-validation' | 'admin-reconciliation' | 'metadata-staging' {
  if (item.expected.parse.outcome === 'rejected') return 'parse';
  if (item.expected.packageValidation.outcome === 'rejected') return 'package-validation';
  if (item.expected.reconciliation.outcome === 'rejected') return 'admin-reconciliation';
  return 'metadata-staging';
}

describe('release evaluation evidence ledger', () => {
  it('derives complete accounting and corrected seeded-issue totals from the manifest', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const ledger = createReleaseEvidenceLedger(corpus);
    corpus.cases.forEach((item) => {
      if (item.expected.persistence === 'persisted') {
        recordReleaseObservation(ledger, { caseId: item.caseId, stage: 'final-persistence', outcome: 'accepted', persisted: true });
      } else {
        recordReleaseObservation(ledger, {
          caseId: item.caseId,
          stage: expectedRejectedStage(item),
          outcome: 'rejected',
          code: item.expected.metadataStaging.code || item.expected.packageValidation.code || item.expected.parse.code || item.expected.reconciliation.code,
          fieldName: item.expected.parse.fieldName || item.expected.packageValidation.fieldName || item.expected.reconciliation.fieldName,
          persisted: false,
        });
      }
    });
    corpus.seededIssues.forEach((issue) => recordReleaseObservation(ledger, {
      caseId: issue.caseId,
      stage: issue.expectedDetectionStage,
      attempt: `issue-${issue.issueId}`,
      outcome: issue.evaluationCriticality === 'non_critical' ? 'warning' : 'rejected',
      code: issue.expectedProductionCode,
      fieldName: issue.expectedFieldName,
    }));

    const accounting = evaluateReleaseAccounting(ledger);
    const metrics = deriveSeededIssueMetrics(corpus.seededIssues, ledger);
    expect(accounting.unexpectedOrUnaccounted).toBe(0);
    expect(metrics).toMatchObject({
      criticalTotal: 32,
      criticalDetected: 32,
      criticalMissed: 0,
      nonCriticalTotal: 20,
      nonCriticalDetected: 20,
      totalSeededIssues: 52,
      totalDetected: 52,
      overallPercentage: 100,
    });
  });

  it('detects unknown, duplicate, impossible, missing, and mismatched lineage', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: corpus.cases.slice(0, 1), seededIssues: [], negativeControls: [] });
    recordReleaseObservation(ledger, { caseId: corpus.cases[0].caseId, stage: 'final-persistence', outcome: 'accepted', persisted: true });
    recordReleaseObservation(ledger, { caseId: corpus.cases[0].caseId, stage: 'final-persistence', outcome: 'accepted', persisted: true });
    recordReleaseObservation(ledger, { caseId: corpus.cases[0].caseId, stage: 'parse', outcome: 'accepted' });
    recordReleaseObservation(ledger, { caseId: 'unknown-release-case', stage: 'parse', outcome: 'accepted' });
    const accounting = evaluateReleaseAccounting(ledger);

    expect(accounting.unknownCaseIds).toEqual(['unknown-release-case']);
    expect(accounting.duplicateStageObservationKeys).toHaveLength(1);
    expect(accounting.impossibleStageCaseIds).toEqual(['release-case-001']);
    expect(accounting.unexpectedOrUnaccounted).toBeGreaterThan(0);
  });

  it('reports missed issues, blocking controls, and gate reasons without timing thresholds', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const ledger = createReleaseEvidenceLedger(corpus);
    const issue = corpus.seededIssues[0];
    recordReleaseObservation(ledger, { caseId: issue.caseId, stage: issue.expectedDetectionStage, attempt: 'issue', outcome: 'rejected', code: 'WRONG_CODE' });
    recordReleaseObservation(ledger, { caseId: corpus.negativeControls[0].caseId, stage: 'package-validation', attempt: 'control', outcome: 'rejected', controlAssertionId: corpus.negativeControls[0].assertionId, blocking: true });
    const report = createReleaseEvaluationReport({
      corpus,
      ledger,
      runtime: { seed: corpus.seed, corpusSize: 132, runNumber: 1, runId: 'run-volatile' },
      cleanup: { completed: false, residue: { projects: 1 }, scopesChecked: ['projects'] },
    });
    expect(report.issueMetrics.missedIssueIds).toContain(issue.issueId);
    expect(report.negativeControls.blockingFalsePositiveIds).toContain(corpus.negativeControls[0].assertionId);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failureReasons).toEqual(expect.arrayContaining([
      'critical seeded issue detection is below 100%',
      'a negative control produced a blocking false positive',
      'cleanup did not prove zero owned residue',
    ]));
    expect(renderReleaseEvaluationJson(report)).toContain('run-volatile');
    expect(renderReleaseEvaluationMarkdown(report)).toContain('Not Demonstrated');
    expect(evaluateReleaseGate(report.accounting, report.issueMetrics, report.negativeControls, false).passed).toBe(false);
  });

  it('aggregates observational timings without imposing a pass threshold', () => {
    expect(summarizeReleaseTimings([
      { import: 3, cleanup: 1 },
      { import: 1, cleanup: 4 },
      { import: 2, cleanup: 2 },
    ])).toEqual({
      cleanup: { minimum: 1, median: 2, maximum: 4 },
      import: { minimum: 1, median: 2, maximum: 3 },
    });
  });

  it('records the manifest-derived failure-stage distribution and per-run timing record', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const ledger = createReleaseEvidenceLedger(corpus);
    corpus.cases.forEach((item) => recordReleaseObservation(ledger, {
      caseId: item.caseId,
      stage: item.expected.persistence === 'persisted' ? 'final-persistence' : expectedRejectedStage(item),
      outcome: item.expected.persistence === 'persisted' ? 'accepted' : 'rejected',
      persisted: item.expected.persistence === 'persisted',
      code: item.expected.persistence === 'rejected' ? item.expected.parse.code || item.expected.packageValidation.code || item.expected.reconciliation.code || item.expected.metadataStaging.code : undefined,
    }));
    const distribution = deriveFailureStageDistribution(corpus, ledger);
    expect(distribution.matches).toBe(true);
    expect(distribution.actual).toEqual(distribution.expected);

    const report = createReleaseEvaluationReport({
      corpus,
      ledger,
      runtime: { seed: corpus.seed, corpusSize: 132, runNumber: 2, runId: 'volatile-run' },
      timings: { corpusGeneration: 12.5 },
    });
    expect(report.timingRuns).toEqual([{ runNumber: 2, timings: { corpusGeneration: 12.5 } }]);
    expect(report.kpiEvidence).toEqual({
      staffEffortReductionMeasured: false,
      developerRuntimeIsStaffEffortEvidence: false,
      manualEfficiencyTemplate: 'docs/templates/release-evaluation-manual-efficiency.md',
    });
  });

  it('includes stable cleanup evidence in normalized repeatability comparisons', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const cleanup = {
      completed: true,
      residue: { projects: 0, batches: 0, storage: 0 },
      scopesChecked: ['projects', 'storage', 'batches'],
      baselineChecks: { localAdminUnchanged: true, referenceTaxonomyUnchanged: true },
      forcedFailureProbe: { completed: true, residue: { projects: 0, storage: 0 } },
    };
    const create = (runNumber: number, cleanupOverride = cleanup) => createReleaseEvaluationReport({
      corpus,
      ledger: createReleaseEvidenceLedger(corpus),
      runtime: { seed: corpus.seed, corpusSize: corpus.cases.length, runNumber, runId: `volatile-${runNumber}` },
      cleanup: cleanupOverride,
    });

    expect(compareNormalizedReleaseReports(create(1), create(2))).toEqual({ comparable: true, mismatchFields: [] });
    expect(compareNormalizedReleaseReports(
      create(1),
      create(2, { ...cleanup, residue: { ...cleanup.residue, projects: 1 } }),
    ).comparable).toBe(false);
    expect(compareNormalizedReleaseReports(
      create(1),
      create(2, { ...cleanup, scopesChecked: ['projects', 'storage'] }),
    ).comparable).toBe(false);
    expect(compareNormalizedReleaseReports(
      create(1),
      create(2, { ...cleanup, forcedFailureProbe: { completed: true, residue: { projects: 1, storage: 0 } } }),
    ).comparable).toBe(false);
  });
});
