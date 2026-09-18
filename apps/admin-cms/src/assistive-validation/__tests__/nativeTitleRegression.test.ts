import { describe, expect, it } from 'vitest';
import fixture from './fixtures/native-title-regression.json';
import { parsePhase1ExtractionResult } from '../domain/extractionContract';
import { extractTitleCandidates } from '../deterministic/titleCandidates';
import { evaluateTitleConsistency } from '../deterministic/titleConsistency';

function extraction(blocks: unknown[]) {
  return parsePhase1ExtractionResult({ schema_version: 'assistive-document-extraction/v1', status: 'COMPLETED', source: 'NATIVE_PDF', document_type: 'PDF', page_count: 1, text: 'Synthetic native PDF extraction evidence', blocks, native_quality: 'NATIVE_USABLE', quality_evidence: null, ocr_state: 'NOT_REQUIRED', provider: null, warnings: [], error: null });
}

describe('real synthetic PDF title-regression geometry', () => {
  it.each(fixture.records)('selects the prominent native title rather than accumulated body height: $publicId', record => {
    const input = extraction(record.blocks);
    const candidates = extractTitleCandidates(input);
    expect(candidates[0].text).toBe(record.expectedDocumentTitle);
    expect(candidates[0].blockIndexes).toEqual([0]);
    expect(evaluateTitleConsistency(input, record.expectedDocumentTitle).outcome).toBe('AGREES');
    expect(evaluateTitleConsistency(input, 'Entirely different real project').outcome).toBe('MISMATCH');
    expect(extractTitleCandidates(input)).toEqual(candidates);
  });
  it('does not fabricate a joined title when line geometry is absent', () => {
    const input = extraction([{ page_number: 1, text: 'Plain project title', source: 'NATIVE_PDF', bounding_box: null, confidence: null }, { page_number: 1, text: 'Unrelated body text', source: 'NATIVE_PDF', bounding_box: null, confidence: null }]);
    expect(extractTitleCandidates(input)[0].text).toBe('Plain project title');
    expect(extractTitleCandidates(input).some(candidate => candidate.blockIndexes.length > 1)).toBe(false);
  });
});
