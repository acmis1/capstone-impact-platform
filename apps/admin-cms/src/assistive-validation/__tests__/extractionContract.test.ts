import nativeFixture from '../../../../assistive-worker/tests/fixtures/phase-2-consumer-native-pdf.json';
import { describe, expect, it } from 'vitest';
import { parsePhase1ExtractionResult, phase1ExtractionResultSchema } from '../domain/extractionContract';

function copyFixture(): Record<string, unknown> {
  return structuredClone(nativeFixture) as Record<string, unknown>;
}

function validOcr(): Record<string, unknown> {
  const result = copyFixture();
  result.source = 'OCR';
  result.document_type = 'PNG';
  result.ocr_state = 'COMPLETED';
  result.provider = { provider_id: 'test-ocr', provider_version: '1', runtime_version: null, model_version: null };
  result.blocks = [{ page_number: 1, text: 'AI-Enabled Flood Warning System', source: 'OCR', bounding_box: null, confidence: 0.95 }];
  return result;
}

describe('assistive-document-extraction/v1 strict consumer', () => {
  it('accepts the shared valid native-PDF fixture produced in the Phase 1 shape', () => {
    expect(parsePhase1ExtractionResult(nativeFixture).source).toBe('NATIVE_PDF');
  });

  it('accepts valid OCR, pending OCR, unavailable OCR, and failed results', () => {
    expect(phase1ExtractionResultSchema.safeParse(validOcr()).success).toBe(true);
    const pending = copyFixture();
    Object.assign(pending, { status: 'OCR_REQUIRED', source: 'NONE', document_type: 'PNG', text: '', blocks: [], native_quality: 'NOT_APPLICABLE', quality_evidence: null, ocr_state: 'REQUIRED_NOT_RUN' });
    expect(phase1ExtractionResultSchema.safeParse(pending).success).toBe(true);
    pending.ocr_state = 'UNAVAILABLE';
    pending.provider = { provider_id: 'not-installed', provider_version: null, runtime_version: null, model_version: null };
    expect(phase1ExtractionResultSchema.safeParse(pending).success).toBe(true);
    Object.assign(pending, { status: 'FAILED', source: 'NONE', document_type: null, page_count: 0, native_quality: 'INVALID', ocr_state: 'NOT_REQUIRED', provider: null, error: { code: 'CORRUPT_PDF', message: 'Document is corrupt.' } });
    expect(phase1ExtractionResultSchema.safeParse(pending).success).toBe(true);
  });

  it.each([
    ['unknown field', (raw: Record<string, unknown>) => { raw.unknown = true; }],
    ['missing field', (raw: Record<string, unknown>) => { delete raw.status; }],
    ['unknown schema version', (raw: Record<string, unknown>) => { raw.schema_version = 'assistive-document-extraction/v2'; }],
    ['invalid enum', (raw: Record<string, unknown>) => { raw.status = 'APPROVED'; }],
    ['non-finite geometry', (raw: Record<string, unknown>) => { ((raw.blocks as Array<Record<string, unknown>>)[0].bounding_box as Record<string, unknown>).top = Number.NaN; }],
    ['non-finite OCR confidence', (raw: Record<string, unknown>) => { (raw.blocks as Array<Record<string, unknown>>)[0].confidence = Number.POSITIVE_INFINITY; }],
    ['inverted geometry', (raw: Record<string, unknown>) => { ((raw.blocks as Array<Record<string, unknown>>)[0].bounding_box as Record<string, unknown>).right = -1; }],
    ['invalid page reference', (raw: Record<string, unknown>) => { (raw.blocks as Array<Record<string, unknown>>)[0].page_number = 2; }],
    ['OCR source without completed OCR', (raw: Record<string, unknown>) => { raw.source = 'OCR'; }],
    ['oversized extracted text', (raw: Record<string, unknown>) => { raw.text = 'x'.repeat(100_001); }],
    ['oversized block list', (raw: Record<string, unknown>) => { raw.blocks = Array.from({ length: 5_001 }, () => (nativeFixture.blocks[0])); }],
    ['oversized warning list', (raw: Record<string, unknown>) => { raw.warnings = Array.from({ length: 51 }, () => ({ code: 'OCR_PROVIDER_WARNING', message: 'bounded warning' })); }],
  ])('fails closed for %s', (_name, mutate) => {
    const raw = copyFixture();
    mutate(raw);
    expect(phase1ExtractionResultSchema.safeParse(raw).success).toBe(false);
  });
});
