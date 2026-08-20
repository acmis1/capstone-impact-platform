import { describe, expect, it } from 'vitest';
import { parsePhase1ExtractionResult } from '../domain/extractionContract';
import { extractTitleCandidates, MAX_TITLE_CANDIDATES } from '../deterministic/titleCandidates';

type BlockInput = { text: string; page?: number; top?: number; height?: number; unit?: 'PDF_POINTS_TOP_LEFT' | 'IMAGE_PIXELS_TOP_LEFT'; geometry?: boolean };
function extraction(blocks: BlockInput[]) {
  const actualBlocks = blocks.map((block) => ({
    page_number: block.page ?? 1,
    text: block.text,
    source: 'NATIVE_PDF' as const,
    bounding_box: block.geometry === false ? null : { left: 20, top: block.top ?? 20, right: 500, bottom: (block.top ?? 20) + (block.height ?? 20), unit: block.unit ?? 'PDF_POINTS_TOP_LEFT' },
    confidence: null,
  }));
  return parsePhase1ExtractionResult({
    schema_version: 'assistive-document-extraction/v1', status: 'COMPLETED', source: 'NATIVE_PDF', document_type: 'PDF', page_count: Math.max(1, ...actualBlocks.map((block) => block.page_number)),
    text: actualBlocks.map((block) => block.text).join('\n'), blocks: actualBlocks, native_quality: 'NATIVE_USABLE', quality_evidence: null, ocr_state: 'NOT_REQUIRED', provider: null, warnings: [], error: null,
  });
}

describe('document-derived title candidates', () => {
  it('ranks a one-line top title', () => expect(extractTitleCandidates(extraction([{ text: 'Solar Microgrid Health Monitor', top: 30, height: 36 }]))[0].text).toBe('Solar Microgrid Health Monitor'));
  it('groups two and three wrapped title lines', () => {
    expect(extractTitleCandidates(extraction([{ text: 'AI-Enabled Flood', top: 40, height: 24 }, { text: 'Warning System', top: 68, height: 24 }]))[0].text).toBe('AI-Enabled Flood Warning System');
    expect(extractTitleCandidates(extraction([{ text: 'Urban Heat', top: 40, height: 24 }, { text: 'Island', top: 68, height: 24 }, { text: 'Explorer', top: 96, height: 24 }]))[0].text).toBe('Urban Heat Island Explorer');
  });
  it('ranks a prominent title below a small institutional header', () => {
    const candidates = extractTitleCandidates(extraction([{ text: 'RMIT University', top: 20, height: 8 }, { text: 'AI-Enabled Flood Warning System', top: 60, height: 38 }, { text: 'Poster details', top: 170, height: 12 }]));
    expect(candidates[0].text).toBe('AI-Enabled Flood Warning System');
  });
  it('prioritises the first page over later pages', () => {
    const candidates = extractTitleCandidates(extraction([{ text: 'First Page Project Title', page: 1, top: 80, height: 20 }, { text: 'Huge appendix heading', page: 2, top: 10, height: 90 }]));
    expect(candidates[0].pageNumber).toBe(1);
  });
  it('handles missing geometry and OCR/image geometry', () => {
    expect(extractTitleCandidates(extraction([{ text: 'No Geometry Title', geometry: false }]))[0].boundingBox).toBeNull();
    const candidate = extractTitleCandidates(extraction([{ text: 'OCR Geometry Title', unit: 'IMAGE_PIXELS_TOP_LEFT', top: 100, height: 40 }]))[0];
    expect(candidate.boundingBox?.unit).toBe('IMAGE_PIXELS_TOP_LEFT');
  });
  it('does not let large lower body text outrank a more prominent title', () => {
    const candidates = extractTitleCandidates(extraction([{ text: 'Capstone Project', top: 40, height: 42 }, { text: 'A deliberately long body paragraph that should be evidence but not the title candidate', top: 260, height: 18 }]));
    expect(candidates[0].text).toBe('Capstone Project');
  });
  it('bounds candidates and metadata changes cannot alter their document-only ranking', async () => {
    const source = extraction(Array.from({ length: 20 }, (_, index) => ({ text: `Candidate line ${index + 1}`, top: 20 + index * 100, height: 20 })));
    const before = extractTitleCandidates(source);
    expect(before).toHaveLength(MAX_TITLE_CANDIDATES);
    const { evaluateTitleConsistency } = await import('../deterministic/titleConsistency');
    evaluateTitleConsistency(source, 'A wholly different metadata title');
    evaluateTitleConsistency(source, 'Another metadata title');
    expect(extractTitleCandidates(source)).toEqual(before);
  });
});
