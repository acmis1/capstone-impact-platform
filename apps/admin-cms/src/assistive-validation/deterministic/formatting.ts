import type { AssistiveCheckResult } from '../domain/evidence';
import { ASSISTIVE_EVIDENCE_LIMITS, createAssistiveCheckResult, sanitizeAssistivePlainText } from '../domain/evidence';
import { hasSuspiciousControlCharacters, normalizeLineBreaks } from './normalization';

/** Informational only; this deliberately does not repeat authoritative project validation. */
export function formattingInformation(text: string): AssistiveCheckResult[] {
  const normalizedLines = normalizeLineBreaks(text);
  const result: AssistiveCheckResult[] = [];
  const add = (reasonCode: AssistiveCheckResult['reasonCode'], explanation: string) => result.push(createAssistiveCheckResult({
    checkType: 'FORMATTING', outcome: 'INFORMATION', classification: 'NON_BLOCKING', reasonCode, affectedField: 'extraction_text',
    origin: 'DETERMINISTIC_HELPER', evidenceExcerpt: sanitizeAssistivePlainText(text, ASSISTIVE_EVIDENCE_LIMITS.excerpt), pageNumber: null, boundingBox: null,
    metadataValue: null, normalizedMetadataValue: null, candidateValue: null, normalizedCandidateValue: null, lexicalScore: null, explanation,
  }));
  if (hasSuspiciousControlCharacters(text)) add('SUSPICIOUS_CONTROL_CHARACTERS', 'Text contains replacement or control characters that may reduce comparison quality.');
  if (text !== text.trim()) add('LEADING_OR_TRAILING_WHITESPACE', 'Text contains leading or trailing whitespace.');
  if (/[\t ]{2,}|\n{3,}/.test(normalizedLines)) add('REPEATED_WHITESPACE', 'Text contains repeated whitespace or excessive blank lines.');
  return result;
}
