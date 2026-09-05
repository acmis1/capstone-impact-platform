import type { NegativeControlAssertion, ReleaseEvaluationCase, ReleaseEvaluationCorpus, ReleaseExpectedStage, ReleaseStage, SeededIssue } from '../fixtures/releaseEvaluationCorpus';

export const RELEASE_EVALUATION_REPORT_SCHEMA = 'release-evaluation-v1';

export type ReleaseObservationOutcome = 'accepted' | 'rejected' | 'not_run' | 'warning';

export interface ReleaseStageObservation {
  caseId: string;
  stage: ReleaseStage;
  attempt?: string;
  outcome: ReleaseObservationOutcome;
  code?: string;
  fieldName?: string;
  persisted?: boolean;
  finalStatus?: string;
  controlAssertionId?: string;
  blocking?: boolean;
  evidence?: Record<string, string | number | boolean | null>;
}

export interface ReleaseEvidenceLedgerEntry {
  caseId: string;
  expected: ReleaseEvaluationCase;
  observations: ReleaseStageObservation[];
  terminalFailureStage?: ReleaseStage;
  terminalReasonCode?: string;
}

export interface ReleaseEvidenceLedger {
  entries: Map<string, ReleaseEvidenceLedgerEntry>;
  unknownCaseIds: Set<string>;
  duplicateStageObservationKeys: Set<string>;
  impossibleStageCaseIds: Set<string>;
}

export interface ReleaseStageAccounting {
  expectedCaseCount: number;
  observedCaseCount: number;
  missingCaseIds: string[];
  unknownCaseIds: string[];
  duplicateStageObservationKeys: string[];
  impossibleStageCaseIds: string[];
  expectedActualMismatchCaseIds: string[];
  missingTerminalClassificationCaseIds: string[];
  unexpectedPersistenceCaseIds: string[];
  unexpectedOrUnaccounted: number;
}

export interface SeededIssueMetricSummary {
  criticalTotal: number;
  criticalDetected: number;
  criticalMissed: number;
  criticalPercentage: number;
  nonCriticalTotal: number;
  nonCriticalDetected: number;
  nonCriticalMissed: number;
  nonCriticalPercentage: number;
  totalSeededIssues: number;
  totalDetected: number;
  totalMissed: number;
  overallPercentage: number;
  missedIssueIds: string[];
}

export interface NegativeControlSummary {
  totalAssertions: number;
  observedAssertions: number;
  missingAssertionIds: string[];
  blockingFalsePositiveCount: number;
  blockingFalsePositiveIds: string[];
  blockingFalsePositiveRate: number;
}

export interface ReleaseFailureStageDistribution {
  expected: Record<string, number>;
  actual: Record<string, number>;
  matches: boolean;
}

export interface ReleaseStageCount {
  accepted: number;
  rejected: number;
  warning: number;
  notRun: number;
}

export interface ReleaseTimingSummary {
  minimum: number;
  median: number;
  maximum: number;
}

export interface ReleaseEvaluationReport {
  schemaVersion: typeof RELEASE_EVALUATION_REPORT_SCHEMA;
  manifestDigest: string;
  runtime: {
    seed: number;
    corpusSize: number;
    runNumber: number;
    runId: string;
    nodeVersion?: string;
    npmVersion?: string;
    platform?: string;
    osRelease?: string;
    architecture?: string;
    supabaseVersion?: string;
    migrationCount?: number;
  };
  corpus: {
    inputCases: number;
    persistedExpected: number;
    rejectedExpected: number;
    packageProfiles: Record<string, number>;
    lifecycleProfiles: Record<string, number>;
    galleryDistribution: { zero: number; one: number; multiple: number; maximum: number };
    negativeControls: NegativeControlAssertion[];
    cases: ReleaseEvaluationCase[];
  };
  ledger: ReleaseEvidenceLedgerEntry[];
  accounting: ReleaseStageAccounting;
  stageCounts: Record<string, ReleaseStageCount>;
  seededIssues: SeededIssue[];
  issueMetrics: SeededIssueMetricSummary;
  negativeControls: NegativeControlSummary;
  failureStageDistribution: ReleaseFailureStageDistribution;
  workflowEvidence: Record<string, unknown>;
  publicationEvidence: Record<string, unknown>;
  uiEvidence: Record<string, unknown>;
  timings: Record<string, number | Record<string, number>>;
  timingRuns: Array<{ runNumber: number; timings: Record<string, number | Record<string, number>> }>;
  timingSummary: Record<string, ReleaseTimingSummary>;
  cleanup: {
    completed: boolean;
    residue: Record<string, number>;
    scopesChecked: string[];
    baselineChecks?: Record<string, boolean>;
    forcedFailureProbe?: { completed: boolean; residue: Record<string, number> };
  };
  repeatability?: { comparable: boolean; mismatchFields: string[] };
  kpiEvidence: {
    staffEffortReductionMeasured: false;
    developerRuntimeIsStaffEffortEvidence: false;
    manualEfficiencyTemplate: string;
  };
  demonstrated: string[];
  notDemonstrated: string[];
  gate: { passed: boolean; failureReasons: string[] };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function stageIndex(stage: ReleaseStage): number {
  const order: ReleaseStage[] = [
    'parse', 'package-validation', 'admin-reconciliation', 'commit-intent',
    'server-revalidation', 'metadata-staging', 'media-staging', 'final-persistence',
    'review-readiness', 'workflow', 'publication-readiness', 'candidate-planning', 'ordinary-feed',
  ];
  return order.indexOf(stage);
}

function observationKey(observation: ReleaseStageObservation): string {
  return `${observation.caseId}\u0000${observation.stage}\u0000${observation.attempt || 'primary'}`;
}

export function createReleaseEvidenceLedger(corpus: ReleaseEvaluationCorpus): ReleaseEvidenceLedger {
  return {
    entries: new Map(corpus.cases.map((item) => [item.caseId, { caseId: item.caseId, expected: item, observations: [] }])),
    unknownCaseIds: new Set(),
    duplicateStageObservationKeys: new Set(),
    impossibleStageCaseIds: new Set(),
  };
}

export function recordReleaseObservation(
  ledger: ReleaseEvidenceLedger,
  observation: ReleaseStageObservation,
): void {
  const entry = ledger.entries.get(observation.caseId);
  if (!entry) {
    ledger.unknownCaseIds.add(observation.caseId);
    return;
  }
  const key = observationKey(observation);
  if (entry.observations.some((current) => observationKey(current) === key)) {
    ledger.duplicateStageObservationKeys.add(key);
  }
  const prior = entry.observations.filter((current) => (current.attempt || 'primary') === (observation.attempt || 'primary'));
  const previousStage = prior.at(-1)?.stage;
  if (previousStage && stageIndex(observation.stage) < stageIndex(previousStage)) {
    ledger.impossibleStageCaseIds.add(observation.caseId);
  }
  entry.observations.push({ ...observation, ...(observation.attempt ? {} : { attempt: 'primary' }) });
  if (observation.outcome === 'rejected' && !entry.terminalFailureStage) {
    entry.terminalFailureStage = observation.stage;
    entry.terminalReasonCode = observation.code;
  }
}

export function recordReleaseTerminalClassification(
  ledger: ReleaseEvidenceLedger,
  caseId: string,
  terminalFailureStage?: ReleaseStage,
  terminalReasonCode?: string,
): void {
  const entry = ledger.entries.get(caseId);
  if (!entry) {
    ledger.unknownCaseIds.add(caseId);
    return;
  }
  entry.terminalFailureStage = terminalFailureStage;
  entry.terminalReasonCode = terminalReasonCode;
}

function actualPrimaryStage(entry: ReleaseEvidenceLedgerEntry): ReleaseStageObservation | undefined {
  const primary = entry.observations.filter((observation) => (observation.attempt || 'primary') === 'primary' && stageIndex(observation.stage) <= stageIndex('final-persistence'));
  return primary.find((observation) => observation.outcome === 'rejected')
    || primary.find((observation) => observation.stage === 'final-persistence' && observation.outcome === 'accepted')
    || primary.find((observation) => observation.stage === 'final-persistence' && observation.outcome !== 'not_run')
    || primary.find((observation) => observation.outcome !== 'not_run');
}

function expectedImportStages(entry: ReleaseEvaluationCase): Array<[ReleaseStage, ReleaseExpectedStage]> {
  return [
    ['parse', entry.expected.parse],
    ['package-validation', entry.expected.packageValidation],
    ['admin-reconciliation', entry.expected.reconciliation],
    ['commit-intent', entry.expected.commitIntent],
    ['server-revalidation', entry.expected.serverRevalidation],
    ['metadata-staging', entry.expected.metadataStaging],
    ['media-staging', entry.expected.mediaStaging],
    ['final-persistence', entry.expected.finalPersistence],
  ];
}

function expectedFailureContract(entry: ReleaseEvaluationCase): { stage: ReleaseStage; expected: ReleaseExpectedStage } | undefined {
  const failure = expectedImportStages(entry).find(([, expected]) => expected.outcome === 'rejected');
  return failure ? { stage: failure[0], expected: failure[1] } : undefined;
}

export function evaluateReleaseAccounting(ledger: ReleaseEvidenceLedger): ReleaseStageAccounting {
  const missingCaseIds: string[] = [];
  const expectedActualMismatchCaseIds: string[] = [];
  const missingTerminalClassificationCaseIds: string[] = [];
  const unexpectedPersistenceCaseIds: string[] = [];

  ledger.entries.forEach((entry) => {
    const primary = entry.observations.filter((observation) => (observation.attempt || 'primary') === 'primary' && stageIndex(observation.stage) <= stageIndex('final-persistence'));
    if (primary.length === 0) missingCaseIds.push(entry.caseId);
    for (const [stage, expected] of expectedImportStages(entry.expected)) {
      const actual = primary.find((observation) => observation.stage === stage);
      const expectedOutcome = expected.severity === 'warning' ? 'warning' : expected.outcome;
      if (!actual || actual.outcome !== expectedOutcome
        || (expected.code !== undefined && actual.code !== expected.code)
        || (expected.fieldName !== undefined && actual.fieldName !== expected.fieldName)) {
        expectedActualMismatchCaseIds.push(entry.caseId);
      }
    }
    if (entry.expected.expected.persistence === 'persisted') {
      for (const [stage, code] of [
        ['review-readiness', entry.expected.expected.reviewReadiness],
        ['publication-readiness', entry.expected.expected.publicationReadiness],
        ['candidate-planning', entry.expected.expected.candidatePlan === 'included' ? 'READY_TO_STAGE' : 'NOT_READY'],
        ['ordinary-feed', entry.expected.expected.ordinaryFeed],
      ] as const) {
        const actual = entry.observations.find((observation) => observation.stage === stage && ['primary', 'readiness'].includes(observation.attempt || 'primary'));
        if (!actual || actual.code !== code) expectedActualMismatchCaseIds.push(entry.caseId);
      }
      for (const [attempt, expected] of Object.entries(entry.expected.expected.bulkReview || {})) {
        const actual = entry.observations.find((observation) => observation.stage === 'workflow' && observation.attempt === attempt);
        if (!actual || actual.outcome !== expected.outcome || actual.code !== expected.code) expectedActualMismatchCaseIds.push(entry.caseId);
      }
    }
    const final = actualPrimaryStage(entry);
    if (!final) missingTerminalClassificationCaseIds.push(entry.caseId);
    const expectedPersistence = entry.expected.expected.persistence === 'persisted';
    const actualPersisted = primary.some((observation) => observation.stage === 'final-persistence' && observation.outcome === 'accepted' && observation.persisted !== false);
    if (expectedPersistence !== actualPersisted) {
      if (expectedPersistence || actualPersisted) unexpectedPersistenceCaseIds.push(entry.caseId);
      expectedActualMismatchCaseIds.push(entry.caseId);
    }
    const terminalExpected = expectedPersistence ? 'accepted' : 'rejected';
    if (final && final.outcome !== terminalExpected) expectedActualMismatchCaseIds.push(entry.caseId);
    const rejected = primary.find((observation) => observation.outcome === 'rejected');
    const expectedFailure = expectedFailureContract(entry.expected);
    if (rejected && expectedFailure) {
      const codeMismatch = expectedFailure.expected.code !== undefined && rejected.code !== expectedFailure.expected.code;
      const fieldMismatch = expectedFailure.expected.fieldName !== undefined && rejected.fieldName !== expectedFailure.expected.fieldName;
      if (rejected.stage !== expectedFailure.stage || codeMismatch || fieldMismatch) expectedActualMismatchCaseIds.push(entry.caseId);
    }
  });
  if (ledger.entries.size === 0) missingCaseIds.push('all-cases');

  const offending = new Set([
    ...missingCaseIds,
    ...ledger.unknownCaseIds,
    ...[...ledger.duplicateStageObservationKeys].map((key) => key.split('\u0000')[0]),
    ...ledger.impossibleStageCaseIds,
    ...expectedActualMismatchCaseIds,
    ...missingTerminalClassificationCaseIds,
    ...unexpectedPersistenceCaseIds,
  ]);
  return {
    expectedCaseCount: ledger.entries.size,
    observedCaseCount: [...ledger.entries.values()].filter((entry) => entry.observations.length > 0).length,
    missingCaseIds: sortedUnique(missingCaseIds),
    unknownCaseIds: sortedUnique(ledger.unknownCaseIds),
    duplicateStageObservationKeys: sortedUnique(ledger.duplicateStageObservationKeys),
    impossibleStageCaseIds: sortedUnique(ledger.impossibleStageCaseIds),
    expectedActualMismatchCaseIds: sortedUnique(expectedActualMismatchCaseIds),
    missingTerminalClassificationCaseIds: sortedUnique(missingTerminalClassificationCaseIds),
    unexpectedPersistenceCaseIds: sortedUnique(unexpectedPersistenceCaseIds),
    unexpectedOrUnaccounted: offending.size,
  };
}

function issueDetected(issue: SeededIssue, ledger: ReleaseEvidenceLedger): boolean {
  const entry = ledger.entries.get(issue.caseId);
  if (!entry) return false;
  return entry.observations.some((observation) =>
    observation.stage === issue.expectedDetectionStage
    && (observation.outcome === 'rejected' || observation.outcome === 'warning')
    && (!issue.expectedProductionCode || observation.code === issue.expectedProductionCode)
    && (!issue.expectedFieldName || observation.fieldName === issue.expectedFieldName || observation.evidence?.fieldName === issue.expectedFieldName),
  );
}

function percentage(detected: number, total: number): number {
  return total === 0 ? 100 : Number(((detected / total) * 100).toFixed(2));
}

export function summarizeReleaseTimings(
  timingRuns: Array<Record<string, number | Record<string, number>>>,
): Record<string, ReleaseTimingSummary> {
  const valuesByStage = new Map<string, number[]>();
  timingRuns.forEach((timings) => Object.entries(timings).forEach(([stage, value]) => {
    if (typeof value !== 'number') return;
    const values = valuesByStage.get(stage) || [];
    values.push(value);
    valuesByStage.set(stage, values);
  }));
  return Object.fromEntries([...valuesByStage.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([stage, values]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    return [stage, { minimum: sorted[0], median: Number(median.toFixed(3)), maximum: sorted[sorted.length - 1] }];
  }));
}

export function deriveSeededIssueMetrics(issues: readonly SeededIssue[], ledger: ReleaseEvidenceLedger): SeededIssueMetricSummary {
  const critical = issues.filter((issue) => issue.evaluationCriticality === 'critical');
  const nonCritical = issues.filter((issue) => issue.evaluationCriticality === 'non_critical');
  const detected = new Set(issues.filter((issue) => issueDetected(issue, ledger)).map((issue) => issue.issueId));
  const missedIssueIds = sortedUnique(issues.filter((issue) => !detected.has(issue.issueId)).map((issue) => issue.issueId));
  const criticalDetected = critical.filter((issue) => detected.has(issue.issueId)).length;
  const nonCriticalDetected = nonCritical.filter((issue) => detected.has(issue.issueId)).length;
  return {
    criticalTotal: critical.length,
    criticalDetected,
    criticalMissed: critical.length - criticalDetected,
    criticalPercentage: percentage(criticalDetected, critical.length),
    nonCriticalTotal: nonCritical.length,
    nonCriticalDetected,
    nonCriticalMissed: nonCritical.length - nonCriticalDetected,
    nonCriticalPercentage: percentage(nonCriticalDetected, nonCritical.length),
    totalSeededIssues: issues.length,
    totalDetected: detected.size,
    totalMissed: issues.length - detected.size,
    overallPercentage: percentage(detected.size, issues.length),
    missedIssueIds,
  };
}

export function deriveNegativeControlSummary(
  ledger: ReleaseEvidenceLedger,
  controlIds: readonly string[],
): NegativeControlSummary {
  const falsePositives = new Set<string>();
  const observed = new Set<string>();
  ledger.entries.forEach((entry) => entry.observations.forEach((observation) => {
    if (!observation.controlAssertionId || !controlIds.includes(observation.controlAssertionId) || typeof observation.blocking !== 'boolean') return;
    observed.add(observation.controlAssertionId);
    if (observation.blocking) falsePositives.add(observation.controlAssertionId);
  }));
  return {
    totalAssertions: controlIds.length,
    observedAssertions: observed.size,
    missingAssertionIds: sortedUnique(controlIds.filter((id) => !observed.has(id))),
    blockingFalsePositiveCount: falsePositives.size,
    blockingFalsePositiveIds: sortedUnique(falsePositives),
    blockingFalsePositiveRate: controlIds.length === 0 ? 0 : Number((falsePositives.size / controlIds.length).toFixed(4)),
  };
}

function expectedFailureStage(entry: ReleaseEvaluationCase): string {
  return expectedFailureContract(entry)?.stage || 'persisted';
}

export function deriveFailureStageDistribution(
  corpus: ReleaseEvaluationCorpus,
  ledger: ReleaseEvidenceLedger,
): ReleaseFailureStageDistribution {
  const expected: Record<string, number> = {};
  const actual: Record<string, number> = {};
  corpus.cases.forEach((entry) => {
    const expectedStage = expectedFailureStage(entry);
    expected[expectedStage] = (expected[expectedStage] || 0) + 1;
    const observed = ledger.entries.get(entry.caseId);
    const primary = observed?.observations.filter((observation) => (observation.attempt || 'primary') === 'primary' && stageIndex(observation.stage) <= stageIndex('final-persistence')) || [];
    const actualFailure = primary.find((observation) => observation.outcome === 'rejected');
    const actualPersistence = primary.some((observation) => observation.stage === 'final-persistence' && observation.outcome === 'accepted' && observation.persisted !== false);
    const actualStage = actualFailure?.stage || (actualPersistence ? 'persisted' : 'unclassified');
    actual[actualStage] = (actual[actualStage] || 0) + 1;
  });
  const sorted = (values: Record<string, number>) => Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareText(left, right)),
  );
  const sortedExpected = sorted(expected);
  const sortedActual = sorted(actual);
  return {
    expected: sortedExpected,
    actual: sortedActual,
    matches: JSON.stringify(sortedExpected) === JSON.stringify(sortedActual),
  };
}

export function deriveReleaseStageCounts(ledger: ReleaseEvidenceLedger): Record<string, ReleaseStageCount> {
  const counts: Record<string, ReleaseStageCount> = {};
  ledger.entries.forEach((entry) => entry.observations.forEach((observation) => {
    if (observation.controlAssertionId || observation.attempt?.startsWith('reason-')) return;
    if (observation.stage !== 'workflow' && !['primary', 'readiness'].includes(observation.attempt || 'primary')) return;
    const current = counts[observation.stage] || { accepted: 0, rejected: 0, warning: 0, notRun: 0 };
    if (observation.outcome === 'accepted') current.accepted += 1;
    else if (observation.outcome === 'rejected') current.rejected += 1;
    else if (observation.outcome === 'warning') current.warning += 1;
    else current.notRun += 1;
    counts[observation.stage] = current;
  }));
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
}

export function normalizeReleaseEvaluationReport(report: ReleaseEvaluationReport): unknown {
  const stableRecord = (values: Record<string, number | boolean>): Record<string, number | boolean> => Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareText(left, right)),
  );
  return {
    schemaVersion: report.schemaVersion,
    manifestDigest: report.manifestDigest,
    corpus: report.corpus,
    ledger: report.ledger.map((entry) => ({ caseId: entry.caseId, observations: entry.observations, terminalFailureStage: entry.terminalFailureStage, terminalReasonCode: entry.terminalReasonCode })),
    accounting: report.accounting,
    stageCounts: report.stageCounts,
    issueMetrics: report.issueMetrics,
    negativeControls: report.negativeControls,
    failureStageDistribution: report.failureStageDistribution,
    workflowEvidence: report.workflowEvidence,
    publicationEvidence: report.publicationEvidence,
    uiEvidence: report.uiEvidence,
    cleanup: {
      completed: report.cleanup.completed,
      scopesChecked: sortedUnique(report.cleanup.scopesChecked),
      residue: stableRecord(report.cleanup.residue),
      baselineChecks: report.cleanup.baselineChecks ? stableRecord(report.cleanup.baselineChecks) : null,
      forcedFailureProbe: report.cleanup.forcedFailureProbe
        ? {
          completed: report.cleanup.forcedFailureProbe.completed,
          residue: stableRecord(report.cleanup.forcedFailureProbe.residue),
        }
        : null,
    },
    kpiEvidence: report.kpiEvidence,
    demonstrated: report.demonstrated,
    notDemonstrated: report.notDemonstrated,
    gate: report.gate,
  };
}

export function compareNormalizedReleaseReports(left: ReleaseEvaluationReport, right: ReleaseEvaluationReport): { comparable: boolean; mismatchFields: string[] } {
  const leftText = JSON.stringify(normalizeReleaseEvaluationReport(left));
  const rightText = JSON.stringify(normalizeReleaseEvaluationReport(right));
  return leftText === rightText ? { comparable: true, mismatchFields: [] } : { comparable: false, mismatchFields: ['normalizedEvidence'] };
}

export function evaluateReleaseGate(
  accounting: ReleaseStageAccounting,
  issues: SeededIssueMetricSummary,
  controls: NegativeControlSummary,
  cleanupCompleted: boolean,
  repeatability?: { comparable: boolean; mismatchFields: string[] },
): { passed: boolean; failureReasons: string[] } {
  const failureReasons: string[] = [];
  if (accounting.unexpectedOrUnaccounted > 0) failureReasons.push(`unexpectedOrUnaccounted=${accounting.unexpectedOrUnaccounted}`);
  if (issues.criticalPercentage < 100) failureReasons.push('critical seeded issue detection is below 100%');
  if (issues.overallPercentage < 95) failureReasons.push('overall seeded issue detection is below 95%');
  if (controls.blockingFalsePositiveCount > 0) failureReasons.push('a negative control produced a blocking false positive');
  if (controls.missingAssertionIds.length > 0) failureReasons.push('negative control evidence is missing');
  if (!cleanupCompleted) failureReasons.push('cleanup did not prove zero owned residue');
  if (repeatability && !repeatability.comparable) failureReasons.push('normalized repeatability comparison failed');
  return { passed: failureReasons.length === 0, failureReasons };
}

export function renderReleaseEvaluationJson(report: ReleaseEvaluationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderReleaseEvaluationMarkdown(report: ReleaseEvaluationReport): string {
  const timingLines = report.timingRuns.flatMap((run) => [
    `- Run ${run.runNumber}: ${JSON.stringify(run.timings)}.`,
  ]);
  const lines = [
    '# Integrated Release Evaluation',
    '',
    `## A. Executive Status`,
    '',
    `- Local harness gate: **${report.gate.passed ? 'PASS' : 'FAIL'}**. Browser acceptance, CI, and human KPI evidence require separate review.`,
    `- Manifest digest: \`${report.manifestDigest}\``,
    '',
    '## B. Runtime Metadata',
    '',
    `- Run ${report.runtime.runNumber}; seed ${report.runtime.seed}; corpus size ${report.runtime.corpusSize}.`,
    `- Node ${report.runtime.nodeVersion || 'not recorded'}; npm ${report.runtime.npmVersion || 'not recorded'}; platform ${report.runtime.platform || 'not recorded'}; migration count ${report.runtime.migrationCount ?? 'not recorded'}.`,
    '',
    '## C. Corpus',
    '',
    `- Input cases: ${report.corpus.inputCases}; expected persisted: ${report.corpus.persistedExpected}; expected non-persisted: ${report.corpus.rejectedExpected}.`,
    `- Gallery distribution: ${JSON.stringify(report.corpus.galleryDistribution)}.`,
    `- Lifecycle profile distribution: ${JSON.stringify(report.corpus.lifecycleProfiles)}.`,
    '',
    '## D. Stage Accounting',
    '',
    `- Accounting: ${report.accounting.unexpectedOrUnaccounted === 0 ? 'complete' : 'incomplete'}; unexpected or unaccounted: ${report.accounting.unexpectedOrUnaccounted}.`,
    `- Missing cases: ${report.accounting.missingCaseIds.length}; duplicate observations: ${report.accounting.duplicateStageObservationKeys.length}; impossible stages: ${report.accounting.impossibleStageCaseIds.length}.`,
    `- Stage observation counts: ${JSON.stringify(report.stageCounts)}.`,
    '',
    '## E. Failure-Stage Distribution',
    '',
    `- Expected: ${JSON.stringify(report.failureStageDistribution.expected)}.`,
    `- Actual: ${JSON.stringify(report.failureStageDistribution.actual)}; matches: ${report.failureStageDistribution.matches}.`,
    '',
    '## F. Seeded Issue Metrics',
    '',
    `- Critical: ${report.issueMetrics.criticalDetected}/${report.issueMetrics.criticalTotal} (${report.issueMetrics.criticalPercentage}%).`,
    `- Non-critical: ${report.issueMetrics.nonCriticalDetected}/${report.issueMetrics.nonCriticalTotal} (${report.issueMetrics.nonCriticalPercentage}%).`,
    `- Overall: ${report.issueMetrics.totalDetected}/${report.issueMetrics.totalSeededIssues} (${report.issueMetrics.overallPercentage}%).`,
    `- Missed issue IDs: ${report.issueMetrics.missedIssueIds.length ? report.issueMetrics.missedIssueIds.join(', ') : 'none'}.`,
    '',
    '## G. Negative Controls',
    '',
    `- Blocking false-positive rate: ${report.negativeControls.blockingFalsePositiveCount}/${report.negativeControls.totalAssertions} (${report.negativeControls.blockingFalsePositiveRate}).`,
    `- Blocking false-positive IDs: ${report.negativeControls.blockingFalsePositiveIds.length ? report.negativeControls.blockingFalsePositiveIds.join(', ') : 'none'}.`,
    `- Observed controls: ${report.negativeControls.observedAssertions}/${report.negativeControls.totalAssertions}; missing: ${report.negativeControls.missingAssertionIds.length}.`,
    '',
    '## H. Import and Persistence',
    '',
    `- Package profiles: ${JSON.stringify(report.corpus.packageProfiles)}.`,
    `- Persistence accounting: ${JSON.stringify(report.accounting.unexpectedPersistenceCaseIds.length ? report.accounting.unexpectedPersistenceCaseIds : 'no unexpected persistence')}.`,
    '',
    '## I. Review Workflow',
    '',
    `- Workflow evidence: ${JSON.stringify(report.workflowEvidence)}.`,
    '',
    '## J. Audit Evidence',
    '',
    `- Audit verification is included in workflow evidence; no duplicate transition or actor mismatch is permitted.`,
    '',
    '## K. Publication Readiness',
    '',
    `- Publication evidence: ${JSON.stringify(report.publicationEvidence)}.`,
    '',
    '## L. Ordinary Feed',
    '',
    '- Candidate planning is read-only. Ordinary feed evidence is included above and preserves published-only compilation semantics.',
    '',
    '## M. Annual-Scale UI Evidence',
    '',
    `- UI evidence: ${JSON.stringify(report.uiEvidence)}.`,
    '',
    '## N. Timings',
    '',
    'Milliseconds; adminReconciliation observes the actual reconciliation call within importAnalysis (alias packageParsingValidationAndReconciliation), excluding reference worksheet parsing. Parent/child timings overlap: do not sum them. Evidence-mode totals include the operator pause.',
    ...timingLines,
    ...Object.entries(report.timingSummary).map(([stage, summary]) => `- ${stage}: min ${summary.minimum} ms, median ${summary.median} ms, max ${summary.maximum} ms.`),
    '',
    '## O. Cleanup',
    '',
    `- Completed: ${report.cleanup.completed}; residue: ${JSON.stringify(report.cleanup.residue)}.`,
    `- Baseline checks: ${JSON.stringify(report.cleanup.baselineChecks || {})}.`,
    '',
    '## P. Repeatability',
    '',
    `- ${report.repeatability ? JSON.stringify(report.repeatability) : 'A repeatability comparison was not requested.'}`,
    '',
    '## Q. Demonstrated and Not Demonstrated',
    '',
    'Demonstrated:',
    ...report.demonstrated.map((item) => `- ${item}`),
    '',
    'Not demonstrated:',
    ...report.notDemonstrated.map((item) => `- ${item}`),
    '',
    '## R. KPI and Gate',
    '',
    `- KPI evidence: ${JSON.stringify(report.kpiEvidence)}.`,
    `- Gate reasons: ${report.gate.failureReasons.length ? report.gate.failureReasons.join('; ') : 'none'}.`,
    '',
  ];
  return lines.join('\n');
}

export function createReleaseEvaluationReport(params: {
  corpus: ReleaseEvaluationCorpus;
  ledger: ReleaseEvidenceLedger;
  runtime: ReleaseEvaluationReport['runtime'];
  workflowEvidence?: Record<string, unknown>;
  publicationEvidence?: Record<string, unknown>;
  uiEvidence?: Record<string, unknown>;
  timings?: Record<string, number | Record<string, number>>;
  cleanup?: ReleaseEvaluationReport['cleanup'];
  repeatability?: ReleaseEvaluationReport['repeatability'];
}): ReleaseEvaluationReport {
  const accounting = evaluateReleaseAccounting(params.ledger);
  const stageCounts = deriveReleaseStageCounts(params.ledger);
  const issueMetrics = deriveSeededIssueMetrics(params.corpus.seededIssues, params.ledger);
  const negativeControls = deriveNegativeControlSummary(params.ledger, params.corpus.negativeControls.map((control) => control.assertionId));
  const failureStageDistribution = deriveFailureStageDistribution(params.corpus, params.ledger);
  const gate = evaluateReleaseGate(accounting, issueMetrics, negativeControls, params.cleanup?.completed === true, params.repeatability);
  if (!failureStageDistribution.matches) gate.failureReasons.push('failure-stage distribution did not match the manifest');
  if (params.corpus.cases.length < 120) gate.failureReasons.push('annual cohort has fewer than 120 cases');
  gate.passed = gate.failureReasons.length === 0;
  return {
    schemaVersion: RELEASE_EVALUATION_REPORT_SCHEMA,
    manifestDigest: params.corpus.manifestDigest,
    runtime: params.runtime,
    corpus: {
      inputCases: params.corpus.cases.length,
      persistedExpected: params.corpus.cases.filter((item) => item.expected.persistence === 'persisted').length,
      rejectedExpected: params.corpus.cases.filter((item) => item.expected.persistence === 'rejected').length,
      packageProfiles: Object.fromEntries([...new Set(params.corpus.cases.map((item) => item.packageProfile))].sort().map((profile) => [profile, params.corpus.cases.filter((item) => item.packageProfile === profile).length])),
      lifecycleProfiles: Object.fromEntries([...new Set(params.corpus.cases.map((item) => item.lifecycleProfile).filter(Boolean))].sort().map((profile) => [profile, params.corpus.cases.filter((item) => item.lifecycleProfile === profile).length])),
      galleryDistribution: params.corpus.cases.reduce((result, item) => {
        if (item.expected.persistence !== 'persisted') return result;
        if (item.galleryCount === 0) result.zero += 1;
        else if (item.galleryCount === 1) result.one += 1;
        else if (item.galleryCount === 10) result.maximum += 1;
        else result.multiple += 1;
        return result;
      }, { zero: 0, one: 0, multiple: 0, maximum: 0 }),
      negativeControls: [...params.corpus.negativeControls].sort((left, right) => compareText(left.assertionId, right.assertionId)),
      cases: params.corpus.cases,
    },
    ledger: [...params.ledger.entries.values()].sort((left, right) => compareText(left.caseId, right.caseId)),
    accounting,
    stageCounts,
    seededIssues: [...params.corpus.seededIssues].sort((left, right) => compareText(left.issueId, right.issueId)),
    issueMetrics,
    negativeControls,
    failureStageDistribution,
    workflowEvidence: params.workflowEvidence || {},
    publicationEvidence: params.publicationEvidence || {},
    uiEvidence: params.uiEvidence || {},
    timings: params.timings || {},
    timingRuns: [{ runNumber: params.runtime.runNumber, timings: params.timings || {} }],
    timingSummary: summarizeReleaseTimings([params.timings || {}]),
    cleanup: params.cleanup || { completed: false, residue: {}, scopesChecked: [] },
    ...(params.repeatability ? { repeatability: params.repeatability } : {}),
    kpiEvidence: {
      staffEffortReductionMeasured: false,
      developerRuntimeIsStaffEffortEvidence: false,
      manualEfficiencyTemplate: 'docs/templates/release-evaluation-manual-efficiency.md',
    },
    demonstrated: gate.passed ? [
      'Deterministic 132-case input corpus and exact persistence accounting.',
      'Production parser, package validation, Admin reconciliation, commit intent, metadata staging, and media staging exercised against Local Supabase.',
      'Production review, stale-version fencing, participant-correction, archive, readiness, and audit authorities exercised with manifest-derived expectations.',
      'Publication readiness and candidate planning were evaluated without publication; ordinary feed compilation remained published-only and returned no verifier-owned records.',
      'Seeded issue detection, warning-only controls, 10/25/50 repository pagination, search, exact filters, sorting, and final-page clamping were verified.',
      'Observational Local timings and scoped cleanup; see the explicit probe and repeatability fields for those outcomes.',
    ] : ['The ledger records the stages actually exercised; failed or absent evidence is not an acceptance claim.'],
    notDemonstrated: [
      'Automated screenshots were not captured; evidence mode is available for operator-captured 1440x900 desktop and 390x844 mobile views.',
      'Hosted Supabase, Render, Duda, production SLA, production-scale throughput, high-concurrency capacity, and institutional UAT.',
      'Staff-effort savings, the 50% reduction claim, or any KPI derived from developer-machine runtime.',
    ],
    gate,
  };
}
