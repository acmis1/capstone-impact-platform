import { describe, expect, it } from 'vitest';
import { parsePhase1ExtractionResult } from '../domain/extractionContract';
import { evaluateTitleConsistency } from '../deterministic/titleConsistency';

function completed(lines: string[], lineStep = 50) {
  return parsePhase1ExtractionResult({
    schema_version: 'assistive-document-extraction/v1', status: 'COMPLETED', source: 'NATIVE_PDF', document_type: 'PDF', page_count: 1,
    text: lines.join('\n'), blocks: lines.map((text, index) => ({ page_number: 1, text, source: 'NATIVE_PDF', bounding_box: { left: 20, top: 40 + index * lineStep, right: 500, bottom: 76 + index * lineStep, unit: 'PDF_POINTS_TOP_LEFT' }, confidence: null })),
    native_quality: 'NATIVE_USABLE', quality_evidence: null, ocr_state: 'NOT_REQUIRED', provider: null, warnings: [], error: null,
  });
}

const pendingOcr = parsePhase1ExtractionResult({ schema_version: 'assistive-document-extraction/v1', status: 'OCR_REQUIRED', source: 'NONE', document_type: 'PNG', page_count: 1, text: '', blocks: [], native_quality: 'NOT_APPLICABLE', quality_evidence: null, ocr_state: 'REQUIRED_NOT_RUN', provider: null, warnings: [], error: null });
const noCandidate = parsePhase1ExtractionResult({ schema_version: 'assistive-document-extraction/v1', status: 'COMPLETED', source: 'NATIVE_PDF', document_type: 'PDF', page_count: 1, text: 'Native text', blocks: [], native_quality: 'NATIVE_USABLE', quality_evidence: null, ocr_state: 'NOT_REQUIRED', provider: null, warnings: [], error: null });

describe('Phase 2 deterministic title benchmark regression', () => {
  it('keeps automatic agreement precision at 100% on the labelled regression corpus', () => {
    const cases = [
      { label: 'exact title', metadata: 'AI-Enabled Flood Warning System', extraction: completed(['AI-Enabled Flood Warning System']), expected: 'AGREES', agreesLabel: true },
      { label: 'case-only variation', metadata: 'AI-Enabled Flood Warning System', extraction: completed(['ai-enabled flood warning system']), expected: 'AGREES', agreesLabel: true },
      { label: 'punctuation and hyphen variation', metadata: 'AI-Enabled Flood Warning System', extraction: completed(['AI–Enabled Flood Warning System!']), expected: 'AGREES', agreesLabel: true },
      { label: 'wrapped title', metadata: 'AI-Enabled Flood Warning System', extraction: completed(['AI-Enabled Flood', 'Warning System']), expected: 'AGREES', agreesLabel: true },
      { label: 'OCR glyph mistake', metadata: 'Solar Microgrid Health Monitor', extraction: completed(['Solar Microgrid Heaith Monitor']), expected: 'REVIEW', agreesLabel: false },
      { label: 'spelling variant', metadata: 'Solar Microgrid Analyser', extraction: completed(['Solar Microgrid Analyzer']), expected: 'REVIEW', agreesLabel: false },
      { label: 'morphological variation', metadata: 'Rain Forecast', extraction: completed(['Rain Forecasting']), expected: 'REVIEW', agreesLabel: false },
      { label: 'one-token material substitution', metadata: 'AI-Enabled Flood Warning System', extraction: completed(['AI-Enabled Fire Warning System']), expected: 'MISMATCH', agreesLabel: false },
      { label: 'high-similarity negative', metadata: 'Urban Heat Island Explorer', extraction: completed(['Urban Heat Inland Explorer']), expected: 'MISMATCH', agreesLabel: false },
      { label: 'missing candidate', metadata: 'Any title', extraction: noCandidate, expected: 'NOT_EVALUATED', agreesLabel: false },
      { label: 'OCR not run', metadata: 'Any title', extraction: pendingOcr, expected: 'NOT_EVALUATED', agreesLabel: false },
      { label: 'multiple candidate layout', metadata: 'Project One', extraction: completed(['Project One', 'Project Two'], 260), expected: 'REVIEW', agreesLabel: false },
    ] as const;
    const outcomes = cases.map((entry) => ({ ...entry, outcome: evaluateTitleConsistency(entry.extraction, entry.metadata).outcome }));
    expect(outcomes.map(({ outcome }) => outcome)).toEqual(cases.map(({ expected }) => expected));
    const automatic = outcomes.filter(({ outcome }) => outcome === 'AGREES');
    const positive = outcomes.filter(({ agreesLabel }) => agreesLabel);
    const falseAutomaticAgreements = automatic.filter(({ agreesLabel }) => !agreesLabel).length;
    const precision = automatic.length === 0 ? 1 : (automatic.length - falseAutomaticAgreements) / automatic.length;
    const recall = positive.length === 0 ? 1 : automatic.filter(({ agreesLabel }) => agreesLabel).length / positive.length;
    const reviewRate = outcomes.filter(({ outcome }) => outcome === 'REVIEW').length / outcomes.length;
    const nonAgreementCoverage = outcomes.filter(({ agreesLabel, outcome }) => !agreesLabel && ['REVIEW', 'MISMATCH'].includes(outcome)).length;
    expect({ precision, recall, reviewRate, falseAutomaticAgreements, nonAgreementCoverage }).toEqual({ precision: 1, recall: 1, reviewRate: 4 / 12, falseAutomaticAgreements: 0, nonAgreementCoverage: 6 });
  });
});
