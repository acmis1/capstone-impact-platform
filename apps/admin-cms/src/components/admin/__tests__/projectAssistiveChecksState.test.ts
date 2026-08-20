import { describe, expect, it } from 'vitest';

import type { AssistiveInspectionView, StoredAssistiveFinding } from '../../../assistive-validation';
import {
  assistiveChecksReducer,
  formatCheckType,
  formatDisposition,
  formatFailureCode,
  formatJobStatus,
  formatOutcome,
  initialAssistiveChecksUiState,
  isFindingEligibleToApply,
} from '../projectAssistiveChecksState';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const FINDING_ID = '33333333-3333-4333-8333-333333333333';

const sampleFinding = (overrides: Partial<StoredAssistiveFinding> = {}): StoredAssistiveFinding => ({
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
  reviewedBy: null,
  reviewedAt: null,
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
  it('handles LOAD_STARTED, LOAD_SUCCEEDED, and LOAD_FAILED', () => {
    let state = assistiveChecksReducer(initialAssistiveChecksUiState, { type: 'LOAD_STARTED' });
    expect(state.loading).toBe(true);

    const inspection = sampleInspection();
    state = assistiveChecksReducer(state, { type: 'LOAD_SUCCEEDED', inspection });
    expect(state.loading).toBe(false);
    expect(state.inspection).toEqual(inspection);

    state = assistiveChecksReducer(state, { type: 'LOAD_FAILED', error: 'Network error' });
    expect(state.error).toBe('Network error');
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

  it('handles DISPOSITION_SUCCEEDED updating the specific finding immutably', () => {
    const initial = {
      ...initialAssistiveChecksUiState,
      inspection: sampleInspection(),
    };

    const state = assistiveChecksReducer(initial, {
      type: 'DISPOSITION_SUCCEEDED',
      findingId: FINDING_ID,
      disposition: 'REVIEWED',
      reviewedAt: '2026-08-21T09:10:00.000Z',
      reviewedBy: 'admin-1',
    });

    expect(state.actionInFlight).toBe('idle');
    expect(state.feedback?.message).toBe('Marked as reviewed.');
    expect(state.inspection?.findings[0].disposition).toBe('REVIEWED');
    expect(state.inspection?.findings[0].reviewedBy).toBe('admin-1');
  });

  it('handles APPLY and COPY feedback transitions', () => {
    let state = assistiveChecksReducer(initialAssistiveChecksUiState, { type: 'APPLY_STARTED' });
    expect(state.actionInFlight).toBe('applying');

    state = assistiveChecksReducer(state, {
      type: 'APPLY_COMPLETED',
      message: 'Suggestion applied.',
      success: true,
    });
    expect(state.actionInFlight).toBe('idle');
    expect(state.feedback?.message).toBe('Suggestion applied.');

    state = assistiveChecksReducer(state, { type: 'COPY_FEEDBACK', findingId: FINDING_ID });
    expect(state.copiedFindingId).toBe(FINDING_ID);

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
});

describe('isFindingEligibleToApply', () => {
  it('allows applying when finding is title consistency, current run, candidate present, and staff has edit authority', () => {
    const finding = sampleFinding();
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(true);
  });

  it('forbids applying when the run is STALE', () => {
    const finding = sampleFinding();
    const eligible = isFindingEligibleToApply(finding, 'STALE', true, true);
    expect(eligible).toBe(false);
  });

  it('forbids applying when staff lacks metadata edit permission', () => {
    const finding = sampleFinding();
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', false, true);
    expect(eligible).toBe(false);
  });

  it('forbids applying when finding is not TITLE_CONSISTENCY', () => {
    const finding = sampleFinding({ checkType: 'FORMATTING' });
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(false);
  });

  it('forbids applying when candidate title is empty or missing', () => {
    const finding = sampleFinding({
      evidence: {
        ...sampleFinding().evidence,
        candidateValue: null,
      },
    });
    const eligible = isFindingEligibleToApply(finding, 'CURRENT', true, true);
    expect(eligible).toBe(false);
  });
});
