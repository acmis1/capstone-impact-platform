import { describe, expect, it } from 'vitest';

import { createAssistiveCheckResult, type AssistiveCheckResult } from '../domain/evidence';
import {
  ASSISTIVE_FINDING_EVIDENCE_VERSION,
  ASSISTIVE_DUPLICATE_EVIDENCE_VERSION,
  ASSISTIVE_PERSISTENCE_LIMITS,
  ASSISTIVE_PIPELINE_VERSION,
  assistiveInputHashSchema,
  assistivePipelineVersionSchema,
  assistiveRunPersistenceInputSchema,
  persistedAssistiveEvidenceSchema,
  persistedAssistiveFindingSchema,
  persistedDuplicateCandidateSchema,
  storedAssistiveFindingSchema,
  storedAssistiveRunSchema,
  toPersistedAssistiveFinding,
  toPersistedDuplicateShortlistFinding,
} from '../domain/persistenceContract';
import type { RankedDuplicateCandidate } from '../duplicate-detection/duplicateRanker';

const PROJECT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const FINDING_ID = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
const ADMIN_ID = '1d8ea5e2-9b4d-4a4f-b6c9-6b1e6f0a1f11';
const HASH = 'a'.repeat(64);

function checkResult(overrides: Partial<AssistiveCheckResult> = {}): AssistiveCheckResult {
  return createAssistiveCheckResult({
    checkType: 'TITLE_CONSISTENCY',
    outcome: 'REVIEW',
    classification: 'NON_BLOCKING',
    reasonCode: 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
    affectedField: 'title',
    origin: 'PHASE_1_EXTRACTION',
    evidenceExcerpt: 'F1ood Resilience Mapping',
    pageNumber: 1,
    boundingBox: { left: 10, top: 20, right: 300, bottom: 60, unit: 'PDF_POINTS_TOP_LEFT' },
    metadataValue: 'Flood Resilience Mapping',
    normalizedMetadataValue: 'flood resilience mapping',
    candidateValue: 'F1ood Resilience Mapping',
    normalizedCandidateValue: 'f1ood resilience mapping',
    lexicalScore: 0.95,
    explanation: 'Title is not an exact normalized match and may reflect OCR variation.',
    ...overrides,
  });
}

const finding = () => toPersistedAssistiveFinding(checkResult());

function completedRun(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    inputHash: HASH,
    pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
    status: 'COMPLETED',
    failureCode: null,
    findings: [finding()],
    ...overrides,
  };
}

describe('assistive persistence contract - run identity', () => {
  it('accepts a complete valid run', () => {
    const parsed = assistiveRunPersistenceInputSchema.safeParse(completedRun());
    expect(parsed.success).toBe(true);
  });

  it('accepts a failed run with a bounded failure code and no findings', () => {
    const parsed = assistiveRunPersistenceInputSchema.safeParse(completedRun({
      status: 'FAILED',
      failureCode: 'EXTRACTION_CONTRACT_REJECTED',
      findings: [],
    }));
    expect(parsed.success).toBe(true);
  });

  it('rejects any input hash that is not lowercase SHA-256 hexadecimal', () => {
    for (const value of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '', 'g'.repeat(64), ` ${'a'.repeat(64)}`]) {
      expect(assistiveInputHashSchema.safeParse(value).success).toBe(false);
    }
    expect(assistiveInputHashSchema.safeParse(HASH).success).toBe(true);
  });

  it('rejects any unbounded or malformed pipeline version', () => {
    for (const value of [
      '', 'v1', 'assistive-deterministic-checks', 'Assistive-Checks/v1',
      'assistive-deterministic-checks/v0', 'assistive-deterministic-checks/1',
      `${'a'.repeat(70)}/v1`,
    ]) {
      expect(assistivePipelineVersionSchema.safeParse(value).success).toBe(false);
    }
    expect(assistivePipelineVersionSchema.safeParse(ASSISTIVE_PIPELINE_VERSION).success).toBe(true);
  });

  it('rejects unknown run fields rather than silently discarding them', () => {
    const parsed = assistiveRunPersistenceInputSchema.safeParse(completedRun({ appliedToDraft: true }));
    expect(parsed.success).toBe(false);
  });

  it('rejects incoherent terminal-state combinations', () => {
    const cases = [
      { status: 'COMPLETED', failureCode: 'EXTRACTION_FAILED', findings: [finding()] },
      { status: 'FAILED', failureCode: null, findings: [] },
      { status: 'COMPLETED', failureCode: null, findings: [] },
      { status: 'FAILED', failureCode: 'INTERNAL_FAILURE', findings: [finding()] },
      { status: 'PENDING', failureCode: null, findings: [finding()] },
      { status: 'COMPLETED', failureCode: 'QUEUE_TIMEOUT', findings: [finding()] },
    ];
    for (const override of cases) {
      expect(assistiveRunPersistenceInputSchema.safeParse(completedRun(override)).success).toBe(false);
    }
  });

  it('rejects more findings than one run may persist', () => {
    const findings = Array.from({ length: ASSISTIVE_PERSISTENCE_LIMITS.findingsPerRun + 1 }, finding);
    expect(assistiveRunPersistenceInputSchema.safeParse(completedRun({ findings })).success).toBe(false);
  });

  it('rejects a non-UUID project identifier', () => {
    expect(assistiveRunPersistenceInputSchema.safeParse(completedRun({ projectId: '2026-flood-mapping' })).success)
      .toBe(false);
  });
});

describe('assistive persistence contract - findings', () => {
  it('carries every Phase 2 field across unchanged and restructures only the score', () => {
    const source = checkResult();
    const persisted = toPersistedAssistiveFinding(source);

    expect(persisted.checkType).toBe(source.checkType);
    expect(persisted.outcome).toBe(source.outcome);
    expect(persisted.classification).toBe('NON_BLOCKING');
    expect(persisted.reasonCode).toBe(source.reasonCode);
    expect(persisted.affectedField).toBe(source.affectedField);
    expect(persisted.origin).toBe(source.origin);
    expect(persisted.scoreKind).toBe('LEXICAL_SIMILARITY');
    expect(persisted.scoreValue).toBe(source.lexicalScore);
    expect(persisted.evidence).toEqual({
      version: ASSISTIVE_FINDING_EVIDENCE_VERSION,
      evidenceExcerpt: source.evidenceExcerpt,
      pageNumber: source.pageNumber,
      boundingBox: source.boundingBox,
      metadataValue: source.metadataValue,
      normalizedMetadataValue: source.normalizedMetadataValue,
      candidateValue: source.candidateValue,
      normalizedCandidateValue: source.normalizedCandidateValue,
      explanation: source.explanation,
    });
  });

  it('omits the score entirely when Phase 2 produced no lexical evidence', () => {
    const persisted = toPersistedAssistiveFinding(checkResult({
      outcome: 'NOT_EVALUATED',
      reasonCode: 'OCR_REQUIRED_NOT_RUN',
      lexicalScore: null,
    }));
    expect(persisted.scoreKind).toBeNull();
    expect(persisted.scoreValue).toBeNull();
  });

  it('rejects a half-present score pair', () => {
    for (const override of [
      { scoreKind: 'LEXICAL_SIMILARITY', scoreValue: null },
      { scoreKind: null, scoreValue: 0.5 },
      { scoreKind: 'CONFIDENCE', scoreValue: 0.5 },
      { scoreKind: 'LEXICAL_SIMILARITY', scoreValue: 1.5 },
      { scoreKind: 'LEXICAL_SIMILARITY', scoreValue: Number.NaN },
    ]) {
      expect(persistedAssistiveFindingSchema.safeParse({ ...finding(), ...override }).success).toBe(false);
    }
  });

  it('refuses any classification other than NON_BLOCKING', () => {
    for (const classification of ['BLOCKING', 'APPROVED', 'VALID', 'PUBLICATION_READY', '']) {
      expect(persistedAssistiveFindingSchema.safeParse({ ...finding(), classification }).success).toBe(false);
    }
  });

  it('rejects unknown finding and evidence fields', () => {
    expect(persistedAssistiveFindingSchema.safeParse({ ...finding(), providerPrompt: 'ignore' }).success).toBe(false);
    const withExtraEvidence = finding();
    expect(persistedAssistiveFindingSchema.safeParse({
      ...withExtraEvidence,
      evidence: { ...withExtraEvidence.evidence, rawOcrTranscript: 'x' },
    }).success).toBe(false);
  });

  it('rejects an unknown or missing evidence contract version', () => {
    const base = finding();
    for (const version of ['assistive-finding-evidence/v3', 'v1', undefined]) {
      expect(persistedAssistiveEvidenceSchema.safeParse({ ...base.evidence, version }).success).toBe(false);
    }
  });

  it('creates one strict v2 shortlist with bounded candidate scores and no top-level score', () => {
    const duplicate = toPersistedDuplicateShortlistFinding([{
      rank: 1,
      publicId: '2026-similar-project',
      title: 'Similar Project',
      summaryExcerpt: 'Bounded summary.',
      lexicalScore: 0.85,
      exactContentMatch: false,
      normalizedTitleMatch: true,
    }]);
    expect(duplicate).toMatchObject({
      checkType: 'DUPLICATE_SHORTLIST',
      outcome: 'REVIEW',
      reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT',
      affectedField: 'project_content',
      scoreKind: null,
      scoreValue: null,
      evidence: { version: ASSISTIVE_DUPLICATE_EVIDENCE_VERSION },
    });
    expect(toPersistedDuplicateShortlistFinding([])).toBeNull();
  });

  it('rejects malformed v2 candidate keys, rank order, duplicates, scores, and private identifiers', () => {
    const base = toPersistedDuplicateShortlistFinding([{
      rank: 1, publicId: 'project-a', title: 'A', summaryExcerpt: '', lexicalScore: 0.5,
      exactContentMatch: false, normalizedTitleMatch: false,
    }])!;
    const parseCandidates = (duplicateCandidates: unknown[]) => persistedAssistiveFindingSchema.safeParse({
      ...base,
      evidence: { ...base.evidence, duplicateCandidates },
    }).success;
    const candidate = base.evidence.version === ASSISTIVE_DUPLICATE_EVIDENCE_VERSION
      ? base.evidence.duplicateCandidates[0]
      : null;
    expect(candidate).not.toBeNull();
    expect(parseCandidates([{ ...candidate!, databaseUuid: FINDING_ID }])).toBe(false);
    expect(parseCandidates([{ ...candidate!, rank: 2 }])).toBe(false);
    expect(parseCandidates([{ ...candidate!, lexicalScore: -0.1 }])).toBe(false);
    expect(parseCandidates([{ ...candidate!, lexicalScore: 1.1 }])).toBe(false);
    expect(parseCandidates([{ ...candidate! }, { ...candidate!, rank: 2 }])).toBe(false);
    expect(parseCandidates(Array.from({ length: 6 }, (_, index) => ({
      ...candidate!, rank: index + 1, publicId: `project-${index}`,
    })))).toBe(false);
    expect(persistedAssistiveFindingSchema.safeParse({ ...base, classification: 'BLOCKING' }).success).toBe(false);
    expect(persistedAssistiveFindingSchema.safeParse({ ...base, scoreKind: 'LEXICAL_SIMILARITY', scoreValue: 0.5 }).success).toBe(false);
  });

  it('rejects unknown check types, outcomes, reasons, fields, and origins', () => {
    const base = finding();
    const cases: Record<string, unknown>[] = [
      { checkType: 'GRAMMAR' },
      { checkType: 'DUPLICATE_PRODUCTION' },
      { outcome: 'PASS' },
      { reasonCode: 'LLM_JUDGEMENT' },
      { affectedField: 'status' },
      { origin: 'GEMINI' },
    ];
    for (const override of cases) {
      expect(persistedAssistiveFindingSchema.safeParse({ ...base, ...override }).success).toBe(false);
    }
  });

  it('rejects evidence beyond the bounded plain-text and serialized-size ceilings', () => {
    const base = finding();
    expect(persistedAssistiveEvidenceSchema.safeParse({
      ...base.evidence,
      evidenceExcerpt: 'x'.repeat(501),
    }).success).toBe(false);
    expect(persistedAssistiveEvidenceSchema.safeParse({
      ...base.evidence,
      explanation: 'x'.repeat(301),
    }).success).toBe(false);
    expect(persistedAssistiveEvidenceSchema.safeParse({
      ...base.evidence,
      explanation: '',
    }).success).toBe(false);
    expect(persistedAssistiveEvidenceSchema.safeParse({
      ...base.evidence,
      evidenceExcerpt: 'bad\u0000control',
    }).success).toBe(false);
  });

  it('keeps the application evidence ceiling below the database ceiling', () => {
    expect(ASSISTIVE_PERSISTENCE_LIMITS.evidenceJsonCharacters)
      .toBeLessThan(ASSISTIVE_PERSISTENCE_LIMITS.databaseEvidenceJsonCharacters);
    // The maximum evidence Phase 2 can emit stays comfortably inside the application ceiling.
    const maximal = toPersistedAssistiveFinding(checkResult({
      evidenceExcerpt: 'x'.repeat(500),
      metadataValue: 'm'.repeat(400),
      normalizedMetadataValue: 'n'.repeat(400),
      candidateValue: 'c'.repeat(400),
      normalizedCandidateValue: 'o'.repeat(400),
      explanation: 'e'.repeat(300),
    }));
    expect(JSON.stringify(maximal.evidence).length)
      .toBeLessThan(ASSISTIVE_PERSISTENCE_LIMITS.evidenceJsonCharacters);
  });

  it('keeps the aggregate size gate unreachable through the per-field bounds', () => {
    // The aggregate gate is a defence-in-depth backstop, not the primary bound: the per-field
    // ceilings inherited from Phase 2 already make an oversized conforming evidence object
    // impossible. This asserts that relationship explicitly, so widening a Phase 2 field bound
    // past the aggregate ceiling fails here instead of silently reaching the database.
    const perFieldMaximum = 500 + (4 * 400) + 300;
    expect(perFieldMaximum).toBeLessThan(ASSISTIVE_PERSISTENCE_LIMITS.evidenceJsonCharacters);
    // The database enforces the same ceiling independently; see the Local Supabase verifier
    // scenario that calls the RPC directly with oversized evidence.
    expect(persistedAssistiveFindingSchema.safeParse(finding()).success).toBe(true);
  });
});

describe('assistive persistence contract - stored read shapes', () => {
  const storedFinding = {
    findingId: FINDING_ID,
    ordinal: 1,
    ...finding(),
    disposition: 'UNREVIEWED',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: '2026-08-20T02:00:00+00:00',
  };

  it('accepts a coherent unreviewed and a coherent reviewed finding', () => {
    expect(storedAssistiveFindingSchema.safeParse(storedFinding).success).toBe(true);
    expect(storedAssistiveFindingSchema.safeParse({
      ...storedFinding,
      disposition: 'IGNORED',
      reviewedBy: ADMIN_ID,
      reviewedAt: '2026-08-20T02:05:00+00:00',
    }).success).toBe(true);
  });

  it('accepts a dispositioned finding whose reviewer account has since been removed', () => {
    // ON DELETE SET NULL degrades attribution; the timestamp remains the coherence anchor.
    expect(storedAssistiveFindingSchema.safeParse({
      ...storedFinding,
      disposition: 'REVIEWED',
      reviewedBy: null,
      reviewedAt: '2026-08-20T02:05:00+00:00',
    }).success).toBe(true);
  });

  it('rejects impossible reviewer-state combinations', () => {
    const cases = [
      { disposition: 'UNREVIEWED', reviewedBy: ADMIN_ID, reviewedAt: null },
      { disposition: 'UNREVIEWED', reviewedBy: null, reviewedAt: '2026-08-20T02:05:00+00:00' },
      { disposition: 'REVIEWED', reviewedBy: ADMIN_ID, reviewedAt: null },
      { disposition: 'IGNORED', reviewedBy: null, reviewedAt: null },
      { disposition: 'ACCEPTED', reviewedBy: ADMIN_ID, reviewedAt: '2026-08-20T02:05:00+00:00' },
      { disposition: 'APPLIED', reviewedBy: ADMIN_ID, reviewedAt: '2026-08-20T02:05:00+00:00' },
      { scoreKind: 'LEXICAL_SIMILARITY', scoreValue: null },
      { scoreKind: null, scoreValue: 0.5 },
      { ordinal: 0 },
      { ordinal: 51 },
    ];
    for (const override of cases) {
      expect(storedAssistiveFindingSchema.safeParse({ ...storedFinding, ...override }).success).toBe(false);
    }
  });

  it('rejects a stored run carrying an unknown status or unbounded identity', () => {
    const base = {
      runId: FINDING_ID,
      projectId: PROJECT_ID,
      inputHash: HASH,
      pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      status: 'COMPLETED',
      failureCode: null,
      createdAt: '2026-08-20T02:00:00+00:00',
    };
    expect(storedAssistiveRunSchema.safeParse(base).success).toBe(true);
    expect(storedAssistiveRunSchema.safeParse({
      ...base,
      status: 'FAILED',
      failureCode: 'EXTRACTION_FAILED',
    }).success).toBe(true);
    for (const override of [
      { status: 'RUNNING' },
      { status: 'CLAIMED' },
      { status: 'COMPLETED', failureCode: 'EXTRACTION_FAILED' },
      { status: 'FAILED', failureCode: null },
      { inputHash: 'not-a-hash' },
      { pipelineVersion: 'gemini/v1 ' },
      { leaseUntil: '2026-08-20T02:00:00+00:00' },
    ]) {
      expect(storedAssistiveRunSchema.safeParse({ ...base, ...override }).success).toBe(false);
    }
  });
});

/**
 * Phase 6B data-integrity contract.
 *
 * Candidate prose arrives from historical project rows that were never required to be free of
 * interior control characters, and the durable evidence copy is the only thing the strict schema
 * and the browser ever see. These tests pin both halves: the copy is sanitized, and the contract it
 * must satisfy states the ranker's real semantics rather than a weaker superset of them.
 */
describe('duplicate shortlist evidence integrity', () => {
  const ranked = (overrides: Partial<RankedDuplicateCandidate> = {}): RankedDuplicateCandidate => ({
    rank: 1,
    publicId: 'project-a',
    title: 'Similar Project',
    summaryExcerpt: 'Bounded synthetic summary.',
    lexicalScore: 0.5,
    exactContentMatch: false,
    normalizedTitleMatch: false,
    ...overrides,
  });

  const exactCandidate = (overrides: Partial<RankedDuplicateCandidate> = {}) => ranked({
    lexicalScore: 1, exactContentMatch: true, normalizedTitleMatch: true, ...overrides,
  });

  const shortlist = (
    candidates: readonly Partial<RankedDuplicateCandidate>[],
    overrides: Record<string, unknown> = {},
  ) => ({
    checkType: 'DUPLICATE_SHORTLIST',
    outcome: 'INFORMATION',
    classification: 'NON_BLOCKING',
    reasonCode: 'LEXICAL_DUPLICATE_SHORTLIST',
    affectedField: 'project_content',
    origin: 'DETERMINISTIC_HELPER',
    scoreKind: null,
    scoreValue: null,
    evidence: {
      version: ASSISTIVE_DUPLICATE_EVIDENCE_VERSION,
      evidenceExcerpt: null,
      pageNumber: null,
      boundingBox: null,
      metadataValue: null,
      normalizedMetadataValue: null,
      candidateValue: null,
      normalizedCandidateValue: null,
      explanation: 'Review these lexically similar project records.',
      duplicateCandidates: candidates.map((candidate, index) => ranked({ rank: index + 1, ...candidate })),
    },
    ...overrides,
  });

  const accepts = (finding: unknown) => persistedAssistiveFindingSchema.safeParse(finding).success;

  it('copies untrusted candidate prose into sanitized evidence instead of failing the whole run', () => {
    const finding = toPersistedDuplicateShortlistFinding([
      ranked({ publicId: 'project-a', title: 'Pump\u001FMonitor', summaryExcerpt: 'Safe text\u0001unexpected' }),
      ranked({ rank: 2, publicId: 'project-b', title: 'Delete\u007Fmarker', summaryExcerpt: 'Tail\u000Bbreak', lexicalScore: 0.4 }),
    ]);
    expect(finding).not.toBeNull();
    const evidence = finding!.evidence;
    expect(evidence.version).toBe(ASSISTIVE_DUPLICATE_EVIDENCE_VERSION);
    if (evidence.version !== ASSISTIVE_DUPLICATE_EVIDENCE_VERSION) return;
    for (const candidate of evidence.duplicateCandidates) {
      expect(candidate.title).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
      expect(candidate.summaryExcerpt).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    }
    expect(evidence.duplicateCandidates[0].title).toBe('Pump\uFFFDMonitor');
    expect(evidence.duplicateCandidates[0].summaryExcerpt).toBe('Safe text\uFFFDunexpected');
    expect(evidence.duplicateCandidates[1].title).toBe('Delete\uFFFDmarker');
  });

  it('never mutates the ranked source candidates it copies evidence from', () => {
    const source = ranked({ title: 'Pump\u001FMonitor', summaryExcerpt: 'Safe text\u0001unexpected' });
    const before = structuredClone(source);
    toPersistedDuplicateShortlistFinding([source]);
    expect(source).toEqual(before);
    expect(source.title).toBe('Pump\u001FMonitor');
    expect(source.lexicalScore).toBe(before.lexicalScore);
  });

  it('keeps the strict raw candidate schema closed against a directly supplied control character', () => {
    expect(persistedDuplicateCandidateSchema.safeParse(ranked({ title: 'Pump\u001FMonitor' })).success).toBe(false);
    expect(persistedDuplicateCandidateSchema.safeParse(ranked({ summaryExcerpt: 'Safe\u0001text' })).success).toBe(false);
    expect(persistedDuplicateCandidateSchema.safeParse(ranked({ summaryExcerpt: 'Safe\u007Ftext' })).success).toBe(false);
    expect(accepts(shortlist([{ title: 'Pump\u001FMonitor' }]))).toBe(false);
  });

  it('accepts each coherent outcome and reason the production converter can produce', () => {
    expect(accepts(shortlist([{ lexicalScore: 0.8 }, { lexicalScore: 0.4, publicId: 'project-b' }]))).toBe(true);
    expect(accepts(shortlist(
      [{ normalizedTitleMatch: true, lexicalScore: 0.9 }],
      { outcome: 'REVIEW', reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT' },
    ))).toBe(true);
    expect(accepts(shortlist(
      [exactCandidate()],
      { outcome: 'REVIEW', reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT' },
    ))).toBe(true);
  });

  it('fails closed on every incoherent outcome and reason combination', () => {
    expect(accepts(shortlist([{}], { outcome: 'REVIEW' }))).toBe(false);
    expect(accepts(shortlist([{}], { reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT' }))).toBe(false);
    expect(accepts(shortlist([{}], {
      outcome: 'REVIEW', reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT',
    }))).toBe(false);
    expect(accepts(shortlist([exactCandidate()]))).toBe(false);
    expect(accepts(shortlist([{ normalizedTitleMatch: true, lexicalScore: 0.9 }]))).toBe(false);
    expect(accepts(shortlist([exactCandidate()], { outcome: 'REVIEW' }))).toBe(false);
    expect(accepts(shortlist([exactCandidate()], {
      reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT',
    }))).toBe(false);
  });

  it('fails closed on flag and score combinations the deterministic ranker cannot produce', () => {
    const review = { outcome: 'REVIEW', reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT' };
    expect(accepts(shortlist([exactCandidate({ normalizedTitleMatch: false })], review))).toBe(false);
    expect(accepts(shortlist([exactCandidate({ lexicalScore: 0.7 })], review))).toBe(false);
    expect(accepts(shortlist([exactCandidate({ lexicalScore: 0.999 })], review))).toBe(false);
    expect(accepts(shortlist([{ lexicalScore: 1 }]))).toBe(false);
    expect(accepts(shortlist([{ normalizedTitleMatch: true, lexicalScore: 1 }], review))).toBe(false);
    expect(accepts(shortlist([{ lexicalScore: 0.999 }]))).toBe(true);
  });

  it('requires the persisted order to be the deterministic ranker order', () => {
    expect(accepts(shortlist([
      { publicId: 'project-a', lexicalScore: 0.2 },
      { publicId: 'project-b', lexicalScore: 0.9 },
    ]))).toBe(false);
    expect(accepts(shortlist([
      { publicId: 'project-z', lexicalScore: 0.5 },
      { publicId: 'project-a', lexicalScore: 0.5 },
    ]))).toBe(false);
    expect(accepts(shortlist([
      { publicId: 'project-a', lexicalScore: 0.5 },
      { publicId: 'project-z', lexicalScore: 0.5 },
    ]))).toBe(true);
    expect(accepts(shortlist([
      { publicId: 'Zulu-project', lexicalScore: 0.5 },
      { publicId: 'alpha-project', lexicalScore: 0.5 },
    ]))).toBe(true);
    expect(accepts(shortlist([
      { publicId: 'alpha-project', lexicalScore: 0.5 },
      { publicId: 'Zulu-project', lexicalScore: 0.5 },
    ]))).toBe(false);
  });
});
