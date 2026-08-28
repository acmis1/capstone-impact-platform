import { describe, expect, it } from 'vitest';

import type { AssistiveInspectionFinding, AssistiveInspectionView } from '../../../assistive-validation';
import {
  assistiveChecksReducer,
  formatCheckType,
  formatDisposition,
  formatFailureCode,
  formatJobStatus,
  formatOutcome,
  formatPartialNoticeDescription,
  initialAssistiveChecksUiState,
  isFindingEligibleToApply,
  isLanguageFindingEligibleToApply,
} from '../projectAssistiveChecksState';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const FINDING_ID = '33333333-3333-4333-8333-333333333333';

const sampleFinding = (overrides: Partial<AssistiveInspectionFinding> = {}): AssistiveInspectionFinding => ({
  findingId: FINDING_ID,
  ordinal: 1,
  checkType: 'TITLE_CONSISTENCY',
  outcome: 'REVIEW',
  classification: 'NON_BLOCKING',
  reasonCode: 'MATERIAL_TOKEN_DIFFERENCE',
  affectedField: 'title',
  origin: 'DETERMINISTIC_HELPER',
  scoreKind: 'LEXICAL_SIMILARITY',
  scoreValue: 0.85,
  evidence: {
    version: 'assistive-finding-evidence/v1',
    evidenceExcerpt: 'Impact Assessment of Smart Cities',
    pageNumber: 1,
    boundingBox: null,
    metadataValue: 'Smart Cities Impact',
    normalizedMetadataValue: 'smart cities impact',
    candidateValue: 'Impact Assessment of Smart Cities',
    normalizedCandidateValue: 'impact assessment of smart cities',
    explanation: 'The poster title has high lexical similarity with the metadata title.',
  },
  disposition: 'UNREVIEWED',
  createdAt: '2026-08-21T09:00:00.000Z',
  ...overrides,
});

const sampleInspection = (overrides: Partial<AssistiveInspectionView> = {}): AssistiveInspectionView => ({
  runId: RUN_ID,
  runStatus: 'COMPLETED',
  jobStatus: 'COMPLETED',
  attemptCount: 1,
  failureCode: null,
  cancellationRequested: false,
  createdAt: '2026-08-21T09:00:00.000Z',
  startedAt: '2026-08-21T09:00:01.000Z',
  completedAt: '2026-08-21T09:00:05.000Z',
  findings: [sampleFinding()],
  staleState: 'CURRENT',
  ...overrides,
});

describe('assistiveChecksReducer', () => {
  it('handles load lifecycle and coherent server snapshot synchronization', () => {
    let state = assistiveChecksReducer(initialAssistiveChecksUiState, { type: 'LOAD_STARTED' });
    expect(state.loading).toBe(true);

    const inspection = sampleInspection();
    state = assistiveChecksReducer(state, { type: 'LOAD_SUCCEEDED', inspection });
    expect(state.loading).toBe(false);
    expect(state.inspection).toEqual(inspection);
    expect(state.readUnavailable).toBe(false);

    state = assistiveChecksReducer(state, { type: 'LOAD_FAILED', error: 'Network error' });
    expect(state.error).toBe('Network error');

    state = assistiveChecksReducer(state, {
      type: 'SYNC_SERVER_SNAPSHOT',
      inspection: null,
      readUnavailable: true,
    });
    expect(state.readUnavailable).toBe(true);
  });

  it('does not let an older server snapshot replace a newer client inspection', () => {
    const newerInspection = sampleInspection({ createdAt: '2026-08-21T10:00:00.000Z' });
    const olderInspection = sampleInspection({
      runId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-08-21T09:00:00.000Z',
    });

    const state = assistiveChecksReducer(
      { ...initialAssistiveChecksUiState, inspection: newerInspection },
      { type: 'SYNC_SERVER_SNAPSHOT', inspection: olderInspection, readUnavailable: false },
    );

    expect(state.inspection).toEqual(newerInspection);
  });

  it('clears only the active run targeted by a NOT_FOUND poll', () => {
    const inspection = sampleInspection({ runStatus: 'RUNNING', jobStatus: 'EXTRACTING' });
    const initial = { ...initialAssistiveChecksUiState, inspection };

    const unchanged = assistiveChecksReducer(initial, {
      type: 'ACTIVE_RUN_NOT_FOUND',
      runId: '11111111-1111-4111-8111-111111111111',
    });
    expect(unchanged).toBe(initial);

    const missing = assistiveChecksReducer(initial, { type: 'ACTIVE_RUN_NOT_FOUND', runId: RUN_ID });
    expect(missing.inspection).toBeNull();
    expect(missing.readUnavailable).toBe(true);
    expect(missing.error).toContain('no longer available');
  });

  it('handles RUN lifecycle and transitions', () => {
    let state = assistiveChecksReducer(initialAssistiveChecksUiState, { type: 'RUN_STARTED' });
    expect(state.actionInFlight).toBe('running');

    state = assistiveChecksReducer(state, { type: 'RUN_SUCCEEDED', runId: RUN_ID, status: 'QUEUED' });
    expect(state.actionInFlight).toBe('idle');

    state = assistiveChecksReducer(state, { type: 'RUN_FAILED', error: 'No media' });
    expect(state.actionInFlight).toBe('idle');
    expect(state.error).toBe('No media');
  });

  it('handles DISPOSITION_SUCCEEDED updating the specific finding immutably without staff identity', () => {
    const initial = {
      ...initialAssistiveChecksUiState,
      inspection: sampleInspection(),
    };

    const state = assistiveChecksReducer(initial, {
      type: 'DISPOSITION_SUCCEEDED',
      findingId: FINDING_ID,
      disposition: 'REVIEWED',
    });

    expect(state.actionInFlight).toBe('idle');
    expect(state.feedback?.message).toBe('Marked as reviewed.');
    expect(state.inspection?.findings[0].disposition).toBe('REVIEWED');
  });

  it('handles APPLY and COPY feedback transitions (success and failure)', () => {
    let state = assistiveChecksReducer(initialAssistiveChecksUiState, { type: 'APPLY_STARTED' });
    expect(state.actionInFlight).toBe('applying');

    state = assistiveChecksReducer(state, {
      type: 'APPLY_COMPLETED',
      message: 'Suggestion applied.',
      success: true,
    });
    expect(state.actionInFlight).toBe('idle');
    expect(state.feedback?.message).toBe('Suggestion applied.');

    state = assistiveChecksReducer(state, {
      type: 'APPLY_COMPLETED',
      message: 'The draft changed; run checks again before applying this suggestion.',
      success: false,
    });
    expect(state.feedback).toEqual({
      message: 'The draft changed; run checks again before applying this suggestion.',
      type: 'warning',
    });

    state = assistiveChecksReducer(state, { type: 'COPY_FEEDBACK', findingId: FINDING_ID, status: 'copied' });
    expect(state.copiedFindingId).toBe(FINDING_ID);
    expect(state.copyStatus).toBe('copied');

    state = assistiveChecksReducer(state, { type: 'COPY_FEEDBACK', findingId: FINDING_ID, status: 'failed' });
    expect(state.copiedFindingId).toBe(FINDING_ID);
    expect(state.copyStatus).toBe('failed');

    state = assistiveChecksReducer(state, { type: 'CLEAR_FEEDBACK' });
    expect(state.feedback).toBe(null);
  });
});

describe('formatting and presentation helpers', () => {
  it('formats check types to clear human labels', () => {
    expect(formatCheckType('TITLE_CONSISTENCY')).toBe('Project title');
    expect(formatCheckType('FORMATTING')).toBe('Document formatting');
    expect(formatCheckType('EXTRACTION_INFORMATION')).toBe('Document extraction');
  });

  it('formats outcomes to human badge states', () => {
    expect(formatOutcome('AGREES').label).toBe('Title match');
    expect(formatOutcome('REVIEW').label).toBe('Review suggested');
    expect(formatOutcome('MISMATCH').label).toBe('Possible title mismatch');
    expect(formatOutcome('INFORMATION').label).toBe('Information');
  });

  it('formats active and terminal job statuses', () => {
    expect(formatJobStatus('QUEUED', 'QUEUED').active).toBe(true);
    expect(formatJobStatus('EXTRACTING', 'RUNNING').active).toBe(true);
    expect(formatJobStatus('CHECKING', 'RUNNING').active).toBe(true);
    expect(formatJobStatus('COMPLETED', 'COMPLETED').active).toBe(false);
    expect(formatJobStatus('COMPLETED', 'PARTIAL').label).toBe('Partially completed');
    expect(formatJobStatus('FAILED', 'FAILED').label).toBe('Failed');
  });

  it('formats reviewer dispositions', () => {
    expect(formatDisposition('UNREVIEWED').label).toBe('Unreviewed');
    expect(formatDisposition('REVIEWED').label).toBe('Reviewed');
    expect(formatDisposition('IGNORED').label).toBe('Ignored');
  });

  it('maps known failure codes to helpful explanations', () => {
    expect(formatFailureCode('MEDIA_INVALID')).toContain('poster file is missing');
    expect(formatFailureCode('OCR_REQUIRED')).toContain('OCR text extraction is required');
  });

  it('provides truthful partial notice copy based on OCR capability', () => {
    expect(formatPartialNoticeDescription('OCR_REQUIRED')).toContain('OCR has not run. Native text, when available, was checked.');
    expect(formatPartialNoticeDescription('OCR_PROVIDER_UNAVAILABLE')).toContain('configured OCR capability is unavailable. Native text, when available, was checked.');
    expect(formatPartialNoticeDescription(null)).toContain('Some document content could not be evaluated in this environment.');
  });
});

describe('isFindingEligibleToApply canonical bounds', () => {
  const v1Evidence = () => {
    const evidence = sampleFinding().evidence;
    if (evidence.version !== 'assistive-finding-evidence/v1') throw new Error('Expected v1 evidence');
    return evidence;
  };
  it('allows applying when finding is title consistency, current run, candidate <= 200 chars, and staff has edit authority', () => {
    const finding = sampleFinding();
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(true);
  });

  it('allows applying for exact 200-character candidate title', () => {
    const finding = sampleFinding({
      evidence: {
        ...v1Evidence(),
        candidateValue: 'A'.repeat(200),
      },
    });
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(true);
  });

  it('forbids applying for 201-character candidate title (authoritative limit 200)', () => {
    const finding = sampleFinding({
      evidence: {
        ...v1Evidence(),
        candidateValue: 'A'.repeat(201),
      },
    });
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(false);
  });

  it('forbids applying for blank or whitespace-only candidate title', () => {
    const finding = sampleFinding({
      evidence: {
        ...v1Evidence(),
        candidateValue: '   ',
      },
    });
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(false);
  });

  it('forbids applying when finding outcome is AGREES (already matches)', () => {
    const finding = sampleFinding({ outcome: 'AGREES' });
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(false);
  });

  it('forbids applying when the run is STALE or UNVERIFIABLE', () => {
    const finding = sampleFinding();
    expect(isFindingEligibleToApply(finding, 'STALE', true, true)).toBe(false);
    expect(isFindingEligibleToApply(finding, 'UNVERIFIABLE', true, true)).toBe(false);
  });

  it('forbids applying when staff lacks metadata edit permission or handler is unavailable', () => {
    const finding = sampleFinding();
    expect(isFindingEligibleToApply(finding, 'CURRENT', false, true)).toBe(false);
    expect(isFindingEligibleToApply(finding, 'CURRENT', true, false)).toBe(false);
  });

  it('forbids applying when finding is not TITLE_CONSISTENCY', () => {
    const finding = sampleFinding({ checkType: 'FORMATTING' });
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(false);
  });
});

describe('isLanguageFindingEligibleToApply', () => {
  const languageFinding = (): AssistiveInspectionFinding => ({
    ...sampleFinding(),
    checkType: 'LANGUAGE_SUGGESTION', outcome: 'REVIEW', reasonCode: 'LANGUAGE_SPELLING',
    affectedField: 'summary', origin: 'LOCAL_LANGUAGE_PROVIDER', scoreKind: null, scoreValue: null,
    evidence: {
      version: 'assistive-finding-evidence/v3', startOffset: 2, endOffset: 9,
      offsetUnit: 'UNICODE_CODE_POINTS', originalSourceSpan: 'recieve', contextExcerpt: 'A recieve error.',
      languageCategory: 'LANGUAGE_SPELLING', ruleId: 'MORFOLOGIK_RULE_EN_AU',
      providerId: 'LANGUAGETOOL', providerVersion: '6.6', suggestions: ['receive'],
      explanation: 'Review this possible spelling issue.', inputHash: 'a'.repeat(64),
      pipelineVersion: 'assistive-deterministic-checks/v3',
      policySha256: '3984b958741a5103791524d48ba262a81ef829695ddc122a728c12cc3e689148',
    },
  });
  it('requires current, editable v3 language evidence and a registered draft handler', () => {
    expect(isLanguageFindingEligibleToApply(languageFinding(), 'CURRENT', true, true)).toBe(true);
    expect(isLanguageFindingEligibleToApply(languageFinding(), 'STALE', true, true)).toBe(false);
    expect(isLanguageFindingEligibleToApply(languageFinding(), 'CURRENT', false, true)).toBe(false);
    expect(isLanguageFindingEligibleToApply(languageFinding(), 'CURRENT', true, false)).toBe(false);
  });
});
