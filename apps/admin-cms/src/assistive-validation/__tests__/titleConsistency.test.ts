import { describe, expect, it } from 'vitest';
import { parsePhase1ExtractionResult } from '../domain/extractionContract';
import { evaluateTitleConsistency } from '../deterministic/titleConsistency';

function completed(...titles: Array<{ text: string; top?: number }>) {
  return parsePhase1ExtractionResult({
    schema_version: 'assistive-document-extraction/v1', status: 'COMPLETED', source: 'NATIVE_PDF', document_type: 'PDF', page_count: 1,
    text: titles.map(({ text }) => text).join('\n'),
    blocks: titles.map(({ text, top = 40 }) => ({ page_number: 1, text, source: 'NATIVE_PDF', bounding_box: { left: 20, top, right: 500, bottom: top + 36, unit: 'PDF_POINTS_TOP_LEFT' }, confidence: null })),
    native_quality: 'NATIVE_USABLE', quality_evidence: null, ocr_state: 'NOT_REQUIRED', provider: null, warnings: [], error: null,
  });
}

describe('conservative deterministic title consistency', () => {
  it.each([
    ['exact', 'AI-Enabled Flood Warning System', 'AI-Enabled Flood Warning System'],
    ['case', 'ai-enabled flood warning system', 'AI-Enabled Flood Warning System'],
    ['quotes punctuation and dash', '“AI–Enabled Flood Warning System!”', 'AI-Enabled Flood Warning System'],
  ])('agrees only by normalized identity: %s', (_name, metadata, poster) => {
    expect(evaluateTitleConsistency(completed({ text: poster }), metadata).outcome).toBe('AGREES');
  });

  it('allows aliases only when explicitly supplied as policy input', () => {
    const extraction = completed({ text: 'Flood Warning System' });
    expect(evaluateTitleConsistency(extraction, 'AI-Enabled Flood Warning System').outcome).not.toBe('AGREES');
    expect(evaluateTitleConsistency(extraction, 'AI-Enabled Flood Warning System', { allowedCandidateTitles: ['Flood Warning System'] }).outcome).toBe('AGREES');
  });

  it.each([
    ['Health Monitor', 'Heaith Monitor'],
    ['Solar Microgrid Analyser', 'Solar Microgrid Analyzer'],
    ['Rain Forecast', 'Rain Forecasting'],
  ])('routes noise and variants to review: %s', (metadata, poster) => {
    expect(evaluateTitleConsistency(completed({ text: poster }), metadata).outcome).toBe('REVIEW');
  });

  it.each([
    ['AI-Enabled Flood Warning System', 'AI-Enabled Fire Warning System'],
    ['Urban Heat Island Explorer', 'Urban Heat Inland Explorer'],
  ])('never automatically agrees to material substitutions: %s / %s', (metadata, poster) => {
    expect(evaluateTitleConsistency(completed({ text: poster }), metadata).outcome).not.toBe('AGREES');
  });

  it('returns an informational not-evaluated outcome for extraction and candidate limits', () => {
    const pending = parsePhase1ExtractionResult({ schema_version: 'assistive-document-extraction/v1', status: 'OCR_REQUIRED', source: 'NONE', document_type: 'PNG', page_count: 1, text: '', blocks: [], native_quality: 'NOT_APPLICABLE', quality_evidence: null, ocr_state: 'REQUIRED_NOT_RUN', provider: null, warnings: [], error: null });
    expect(evaluateTitleConsistency(pending, 'A title').reasonCode).toBe('OCR_REQUIRED_NOT_RUN');
    const noBlocks = parsePhase1ExtractionResult({ schema_version: 'assistive-document-extraction/v1', status: 'COMPLETED', source: 'NATIVE_PDF', document_type: 'PDF', page_count: 1, text: 'Native output exists', blocks: [], native_quality: 'NATIVE_USABLE', quality_evidence: null, ocr_state: 'NOT_REQUIRED', provider: null, warnings: [], error: null });
    expect(evaluateTitleConsistency(noBlocks, 'A title').reasonCode).toBe('NO_CREDIBLE_TITLE_CANDIDATE');
  });

  it('routes similarly prominent independent candidates to review', () => {
    expect(evaluateTitleConsistency(completed({ text: 'Project One', top: 40 }, { text: 'Project Two', top: 300 }), 'Project One').reasonCode).toBe('AMBIGUOUS_TITLE_CANDIDATES');
  });

  it('does not crash or leak prohibited controls from metadata title evidence', () => {
    const result = evaluateTitleConsistency(completed({ text: 'Flood Warning System' }), 'Flood\u0000 Warning System');
    expect(result.outcome).toBe('REVIEW');
    expect(result.metadataValue).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    expect(result.normalizedMetadataValue).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  });
});
