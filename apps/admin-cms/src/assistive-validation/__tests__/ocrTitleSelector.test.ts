import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTitleConsistency } from '../deterministic/titleConsistency';
import {
  OCR_TITLE_SELECTOR_ID,
  caseStyle,
  normalizeFrozenTitle,
  selectOcrTitleCandidates,
  typeSize,
  verticalExtentRatio,
} from '../deterministic/ocrTitleSelector';
import { parsePhase1ExtractionResult } from '../domain/extractionContract';

interface Line {
  text: string;
  top: number;
  height: number;
  left?: number;
  right?: number;
  page?: number;
}

interface HoldoutCase {
  id: string;
  media: 'jpeg' | 'png' | 'scanned_pdf';
  metadata_title: string;
}

interface HoldoutRecord {
  blocks: Array<{
    box: { bottom: number; left: number; right: number; top: number };
    confidence: number;
    page_number: number;
    text: string;
  }>;
  case_id: string;
  outcome: string;
  reason: string;
  selected_title: string;
}

const PROVIDER = {
  provider_id: 'paddleocr-local',
  provider_version: 'paddleocr 3.7.0',
  runtime_version: 'paddlepaddle 3.3.0, paddlex 3.7.2',
  model_version: 'PP-OCRv6 Small (det+rec)',
};

const PAGE_BODY: Line[] = [
  { text: 'SCOPE', top: 609, height: 24, left: 54, right: 130 },
  { text: 'Full-page body evidence line.', top: 640, height: 25, left: 54, right: 900 },
  { text: 'LOCAL CARD PAGE 1', top: 1046, height: 17, left: 600, right: 1000 },
];

function ocrExtraction(...lines: Line[]) {
  const all = [...lines, ...PAGE_BODY];
  return parsePhase1ExtractionResult({
    schema_version: 'assistive-document-extraction/v1',
    status: 'COMPLETED',
    source: 'OCR',
    document_type: 'PNG',
    page_count: Math.max(...all.map((line) => line.page ?? 1)),
    text: all.map((line) => line.text).join('\n'),
    blocks: all.map(({ text, top, height, left = 200, right = 1000, page = 1 }) => ({
      page_number: page,
      text,
      source: 'OCR',
      bounding_box: { left, top, right, bottom: top + height, unit: 'IMAGE_PIXELS_TOP_LEFT' },
      confidence: 0.99,
    })),
    native_quality: 'NOT_APPLICABLE',
    quality_evidence: null,
    ocr_state: 'COMPLETED',
    provider: PROVIDER,
    warnings: [],
    error: null,
  });
}

describe('frozen full-page OCR title selector', () => {
  it('exposes the frozen selector identity', () => {
    expect(OCR_TITLE_SELECTOR_ID).toBe('top-band-typography-consistent-group-prominence-v4@geometry');
  });

  it('measures vertical extent from rendered letter classes', () => {
    expect(verticalExtentRatio('Bracken Signal Box Timing')).toBe(0.98);
    expect(verticalExtentRatio('Sheet')).toBe(0.75);
    expect(verticalExtentRatio('COHORT CONTROL COPY')).toBe(0.75);
    expect(verticalExtentRatio('moss')).toBe(0.55);
    expect(caseStyle('COHORT CONTROL COPY')).toBe('UPPER');
    expect(caseStyle('Rowan Silo Moisture Chronicle')).toBe('MIXED');
    expect(caseStyle('2026')).toBe('NEUTRAL');
    expect(typeSize({ left: 0, top: 0, right: 10, bottom: 83, unit: 'IMAGE_PIXELS_TOP_LEFT' }, 'Timing'))
      .toBeCloseTo(83 / 0.98, 3);
  });

  it('joins a short final title line whose ink box lacks descenders', () => {
    const extraction = ocrExtraction(
      { text: 'PP1 FULL PAGE CARD 35', top: 35, height: 19, left: 54, right: 250 },
      { text: 'Bracken Signal Box Timing', top: 171, height: 83 },
      { text: 'Sheet', top: 244, height: 58, left: 700, right: 820 },
    );
    expect(selectOcrTitleCandidates(extraction)[0].text).toBe('Bracken Signal Box Timing Sheet');
  });

  it('never joins an uppercase administrative stamp to a mixed-case title', () => {
    const extraction = ocrExtraction(
      { text: 'PP1 FULL PAGE CARD 23', top: 38, height: 15, left: 54, right: 250 },
      { text: 'COHORT CONTROL COPY', top: 210, height: 40, left: 560, right: 1040 },
      { text: 'Rowan Silo Moisture Chronicle', top: 262, height: 52, left: 380, right: 1220 },
    );
    expect(selectOcrTitleCandidates(extraction)[0].text).toBe('Rowan Silo Moisture Chronicle');
  });

  it('preserves original block identities after geometry ordering', () => {
    const extraction = ocrExtraction(
      { text: 'Second title line', top: 215, height: 45, left: 500, right: 900 },
      { text: 'First title line', top: 160, height: 55, left: 200, right: 900 },
    );
    expect(selectOcrTitleCandidates(extraction)[0]).toMatchObject({
      text: 'First title line Second title line',
      blockIndexes: [1, 0],
    });
  });

  it('ignores pages after the first', () => {
    const extraction = ocrExtraction(
      { text: 'Windlass Terrace Humidity Journal', top: 160, height: 52 },
      { text: 'An Enormous Second Page Heading', top: 100, height: 300, page: 2 },
    );
    expect(selectOcrTitleCandidates(extraction)[0].text).toBe('Windlass Terrace Humidity Journal');
    expect(selectOcrTitleCandidates(extraction).every((candidate) => candidate.pageNumber === 1)).toBe(true);
  });

  it('folds frozen harmless punctuation for equality', () => {
    expect(normalizeFrozenTitle('Tamarind—Depot/ Pallet Rhythm')).toBe('tamarind depot pallet rhythm');
  });
});

describe('OCR-derived title consistency', () => {
  const poster = (title: string, extra: Line[] = []) => ocrExtraction(
    { text: 'PP1 FULL PAGE CARD 01', top: 35, height: 17, left: 54, right: 250 },
    { text: title, top: 160, height: 52 },
    ...extra,
  );

  it.each([
    ['exact', 'Pewter Annex Lighting Compass'],
    ['case', 'pewter annex lighting compass'],
    ['punctuation', 'Pewter Annex: Lighting Compass'],
    ['hyphen', 'Pewter—Annex Lighting Compass'],
  ])('agrees on frozen normalized identity: %s', (_name, metadata) => {
    const result = evaluateTitleConsistency(poster('Pewter Annex Lighting Compass'), metadata);
    expect(result).toMatchObject({ outcome: 'AGREES', reasonCode: 'NORMALIZED_EXACT_MATCH' });
  });

  it('settles an exact match before independent-heading ambiguity', () => {
    const result = evaluateTitleConsistency(
      poster('Ledge Aviary Feather Count', [{ text: 'Aviary Condition Overview', top: 363, height: 50 }]),
      'Ledge Aviary Feather Count',
    );
    expect(result.outcome).toBe('AGREES');
  });

  it('never automatically agrees to a materially different title', () => {
    const result = evaluateTitleConsistency(poster('Fire Warning System'), 'Flood Warning System');
    expect(result).toMatchObject({ outcome: 'MISMATCH', reasonCode: 'MATERIAL_TOKEN_DIFFERENCE' });
  });

  it.each([
    ['number or version', 'Vellum Studio Ink Cycle v7', 'Vellum Studio Ink Cycle v4'],
    ['acronym', 'Basalt Gallery IR Humidity Bulletin', 'Basalt Gallery UV Humidity Bulletin'],
  ])('does not agree to a material %s change', (_name, metadata, posterTitle) => {
    expect(evaluateTitleConsistency(poster(posterTitle), metadata).outcome).not.toBe('AGREES');
  });

  it('reviews similarly prominent independent headings when metadata differs', () => {
    const result = evaluateTitleConsistency(
      poster('Ledge Aviary Feather Count', [{ text: 'Aviary Condition Overview', top: 363, height: 50 }]),
      'Ledge Aviary Plumage Count',
    );
    expect(result.outcome).not.toBe('AGREES');
  });

  it('records bounded provider, model, and runtime identity', () => {
    const result = evaluateTitleConsistency(
      poster('Pewter Annex Lighting Compass'),
      'Pewter Annex Lighting Compass',
    );
    expect(result.explanation).toContain('paddleocr-local');
    expect(result.explanation).toContain('PP-OCRv6 Small');
    expect(result.explanation).toContain('paddlepaddle 3.3.0');
    expect(result.explanation.length).toBeLessThanOrEqual(300);
  });

  it('stays non-blocking and carries no publication authority', () => {
    expect(evaluateTitleConsistency(poster('Fire Warning System'), 'Flood Warning System')).toMatchObject({
      classification: 'NON_BLOCKING', affectedField: 'title', origin: 'PHASE_1_EXTRACTION',
    });
  });

  it('reproduces every recorded v2 holdout decision without rerunning OCR', () => {
    const repoRoot = resolve(process.cwd(), '..', '..');
    const corpus = JSON.parse(readFileSync(resolve(
      repoRoot,
      'tools/assistive-validation-benchmark/ocr-title-fullpage-holdout-v2/corpus/holdout.json',
    ), 'utf8')) as { ocr_cases: HoldoutCase[] };
    const capture = JSON.parse(readFileSync(resolve(
      repoRoot,
      'docs/assistive-validation/evidence/ocr-title-fullpage-holdout-v2/holdout-capture.json',
    ), 'utf8')) as { records: HoldoutRecord[] };
    const casesById = new Map(corpus.ocr_cases.map((item) => [item.id, item]));

    expect(capture.records).toHaveLength(60);
    for (const record of capture.records) {
      const item = casesById.get(record.case_id);
      expect(item, record.case_id).toBeDefined();
      const extraction = parsePhase1ExtractionResult({
        schema_version: 'assistive-document-extraction/v1',
        status: 'COMPLETED',
        source: 'OCR',
        document_type: item?.media === 'scanned_pdf' ? 'PDF' : item?.media.toUpperCase(),
        page_count: Math.max(...record.blocks.map((block) => block.page_number)),
        text: record.blocks.map((block) => block.text).join('\n'),
        blocks: record.blocks.map((block) => ({
          page_number: block.page_number,
          text: block.text,
          source: 'OCR',
          bounding_box: { ...block.box, unit: 'IMAGE_PIXELS_TOP_LEFT' },
          confidence: block.confidence,
        })),
        native_quality: 'NOT_APPLICABLE',
        quality_evidence: null,
        ocr_state: 'COMPLETED',
        provider: PROVIDER,
        warnings: [],
        error: null,
      });
      const candidates = selectOcrTitleCandidates(extraction);
      const result = evaluateTitleConsistency(extraction, item?.metadata_title);

      expect(candidates[0]?.text, record.case_id).toBe(record.selected_title);
      expect(result.outcome, record.case_id).toBe(record.outcome);
      expect(result.reasonCode, record.case_id).toBe(record.reason);
    }
  });

  it('leaves native extraction on the existing selector', () => {
    const native = parsePhase1ExtractionResult({
      schema_version: 'assistive-document-extraction/v1', status: 'COMPLETED', source: 'NATIVE_PDF',
      document_type: 'PDF', page_count: 1, text: 'Native Foundry Control Card',
      blocks: [{
        page_number: 1, text: 'Native Foundry Control Card', source: 'NATIVE_PDF',
        bounding_box: { left: 20, top: 40, right: 500, bottom: 76, unit: 'PDF_POINTS_TOP_LEFT' },
        confidence: null,
      }],
      native_quality: 'NATIVE_USABLE', quality_evidence: null, ocr_state: 'NOT_REQUIRED',
      provider: null, warnings: [], error: null,
    });
    const result = evaluateTitleConsistency(native, 'Native Foundry Control Card');
    expect(result.outcome).toBe('AGREES');
    expect(result.explanation).not.toContain('paddleocr-local');
  });
});
