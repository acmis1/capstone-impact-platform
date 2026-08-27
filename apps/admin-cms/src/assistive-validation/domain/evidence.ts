import { z } from 'zod';
import { phase1BoundingBoxSchema } from './extractionContract';

const boundedPlainText = (maximum: number) => z.string().max(maximum)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), 'Must be plain text.');

const prohibitedPlainTextControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const ASSISTIVE_EVIDENCE_LIMITS = {
  excerpt: 500,
  value: 400,
  explanation: 300,
} as const;

export const assistiveCheckResultSchema = z.object({
  checkType: z.enum([
    'TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION', 'DUPLICATE_SHORTLIST',
    'LANGUAGE_SUGGESTION',
  ]),
  outcome: z.enum(['AGREES', 'REVIEW', 'MISMATCH', 'NOT_EVALUATED', 'INFORMATION']),
  classification: z.literal('NON_BLOCKING'),
  reasonCode: z.enum([
    'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
    'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
    'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
    'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
    'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE',
    'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST',
    'LANGUAGE_SPELLING', 'LANGUAGE_GRAMMAR', 'LANGUAGE_PUNCTUATION',
    'LANGUAGE_CAPITALIZATION', 'LANGUAGE_REPEATED_WORD',
  ]),
  affectedField: z.enum([
    'title', 'summary', 'background', 'solution', 'extraction_text', 'project_content',
  ]),
  origin: z.enum(['PHASE_1_EXTRACTION', 'DETERMINISTIC_HELPER', 'LOCAL_LANGUAGE_PROVIDER']),
  evidenceExcerpt: boundedPlainText(ASSISTIVE_EVIDENCE_LIMITS.excerpt).nullable(),
  pageNumber: z.number().int().min(1).max(10).nullable(),
  boundingBox: phase1BoundingBoxSchema.nullable(),
  metadataValue: boundedPlainText(ASSISTIVE_EVIDENCE_LIMITS.value).nullable(),
  normalizedMetadataValue: boundedPlainText(ASSISTIVE_EVIDENCE_LIMITS.value).nullable(),
  candidateValue: boundedPlainText(ASSISTIVE_EVIDENCE_LIMITS.value).nullable(),
  normalizedCandidateValue: boundedPlainText(ASSISTIVE_EVIDENCE_LIMITS.value).nullable(),
  lexicalScore: z.number().finite().min(0).max(1).nullable(),
  explanation: boundedPlainText(ASSISTIVE_EVIDENCE_LIMITS.explanation),
}).strict();

export type AssistiveCheckResult = z.infer<typeof assistiveCheckResultSchema>;

/** Converts untrusted source text into bounded plain-text evidence without changing the source value. */
export function sanitizeAssistivePlainText(value: string, maximum: number): string {
  return value.slice(0, maximum).replace(prohibitedPlainTextControls, '\uFFFD');
}

export function createAssistiveCheckResult(input: AssistiveCheckResult): AssistiveCheckResult {
  return assistiveCheckResultSchema.parse(input);
}
