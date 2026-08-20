import type { AssistiveCheckResult } from '../domain/evidence';
import { createAssistiveCheckResult } from '../domain/evidence';
import type { Phase1ExtractionResult } from '../domain/extractionContract';
import { extractTitleCandidates } from './titleCandidates';
import { hasSuspiciousControlCharacters } from './normalization';

export function extractionInformationalChecks(extraction: Phase1ExtractionResult): AssistiveCheckResult[] {
  const result: AssistiveCheckResult[] = [];
  const add = (reasonCode: AssistiveCheckResult['reasonCode'], explanation: string) => result.push(createAssistiveCheckResult({
    checkType: 'EXTRACTION_INFORMATION', outcome: 'INFORMATION', classification: 'NON_BLOCKING', reasonCode,
    affectedField: 'extraction_text', origin: 'PHASE_1_EXTRACTION', evidenceExcerpt: null, pageNumber: null, boundingBox: null,
    metadataValue: null, normalizedMetadataValue: null, candidateValue: null, normalizedCandidateValue: null, lexicalScore: null, explanation,
  }));
  if (extraction.status === 'FAILED') add('EXTRACTION_FAILED', 'Extraction failed, so assistive checks could not evaluate document content.');
  if (extraction.status === 'OCR_REQUIRED') add(extraction.ocr_state === 'UNAVAILABLE' ? 'OCR_PROVIDER_UNAVAILABLE' : 'OCR_REQUIRED_NOT_RUN', extraction.ocr_state === 'UNAVAILABLE'
    ? 'OCR is required but the selected provider is unavailable.' : 'OCR is required but has not run.');
  if (extraction.status === 'COMPLETED' && extractTitleCandidates(extraction).length === 0) add('NO_CREDIBLE_TITLE_CANDIDATE', 'Extraction completed without a credible bounded title candidate.');
  if (extraction.status === 'COMPLETED' && extraction.blocks.length > 0 && extraction.blocks.every((block) => block.bounding_box === null)) add('MISSING_GEOMETRY', 'Extraction contains text but no geometry, reducing title candidate quality.');
  if (hasSuspiciousControlCharacters(extraction.text)) add('SUSPICIOUS_CONTROL_CHARACTERS', 'Extraction text contains replacement or control characters.');
  return result;
}
