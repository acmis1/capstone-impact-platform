import { z } from 'zod';

/** Mirrors the bounded Phase 1 worker limits; these are not caller-configurable. */
export const PHASE_1_EXTRACTION_LIMITS = {
  maxPages: 10,
  maxExtractedCharacters: 100_000,
  maxTextBlocks: 5_000,
  maxWarnings: 50,
  maxMessageCharacters: 300,
} as const;

const nonBlankString = (maximum: number) => z.string().max(maximum)
  .refine((value) => value.trim().length > 0, 'Must not be blank.');
const nullableMetadataString = z.string().max(PHASE_1_EXTRACTION_LIMITS.maxMessageCharacters).nullable();

const extractionStatusSchema = z.enum(['COMPLETED', 'OCR_REQUIRED', 'FAILED']);
const extractionSourceSchema = z.enum(['NONE', 'NATIVE_PDF', 'OCR']);
const documentTypeSchema = z.enum(['PDF', 'PNG', 'JPEG']);
const nativeQualitySchema = z.enum(['NATIVE_USABLE', 'OCR_REQUIRED', 'AMBIGUOUS', 'INVALID', 'NOT_APPLICABLE']);
const ocrStateSchema = z.enum(['NOT_REQUIRED', 'REQUIRED_NOT_RUN', 'COMPLETED', 'UNAVAILABLE', 'FAILED']);

export const phase1BoundingBoxSchema = z.object({
  left: z.number().finite(),
  top: z.number().finite(),
  right: z.number().finite(),
  bottom: z.number().finite(),
  unit: z.enum(['PDF_POINTS_TOP_LEFT', 'IMAGE_PIXELS_TOP_LEFT']),
}).strict().superRefine((box, context) => {
  if (box.right < box.left || box.bottom < box.top) {
    context.addIssue({ code: 'custom', message: 'Bounding box coordinates must not be inverted.' });
  }
});

const textBlockSchema = z.object({
  page_number: z.number().int().min(1),
  text: nonBlankString(PHASE_1_EXTRACTION_LIMITS.maxExtractedCharacters),
  source: extractionSourceSchema,
  bounding_box: phase1BoundingBoxSchema.nullable(),
  confidence: z.number().finite().min(0).max(1).nullable(),
}).strict();

const qualityEvidenceSchema = z.object({
  native_character_count: z.number().int().min(0).max(PHASE_1_EXTRACTION_LIMITS.maxExtractedCharacters),
  meaningful_character_count: z.number().int().min(0).max(PHASE_1_EXTRACTION_LIMITS.maxExtractedCharacters),
  printable_ratio: z.number().finite().min(0).max(1),
  replacement_character_count: z.number().int().min(0).max(PHASE_1_EXTRACTION_LIMITS.maxExtractedCharacters),
  text_object_count: z.number().int().min(0).max(10_000),
  reasons: z.array(z.enum([
    'NATIVE_TEXT_PRESENT', 'NO_NATIVE_TEXT', 'SPARSE_NATIVE_TEXT', 'LOW_PRINTABLE_RATIO',
    'EXCESSIVE_REPLACEMENT_CHARACTERS', 'NO_TEXT_OBJECTS', 'PARSER_FAILURE',
  ])).min(1).max(7),
}).strict();

const providerSchema = z.object({
  provider_id: nonBlankString(PHASE_1_EXTRACTION_LIMITS.maxMessageCharacters),
  provider_version: nullableMetadataString,
  runtime_version: nullableMetadataString,
  model_version: nullableMetadataString,
}).strict();

const warningSchema = z.object({
  code: z.enum(['LOW_RESOLUTION_IMAGE', 'NATIVE_TEXT_AMBIGUOUS', 'OCR_PROVIDER_UNAVAILABLE', 'OCR_PROVIDER_WARNING']),
  message: nonBlankString(PHASE_1_EXTRACTION_LIMITS.maxMessageCharacters),
}).strict();

const errorSchema = z.object({
  code: z.enum([
    'EMPTY_INPUT', 'INPUT_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'MIME_SIGNATURE_MISMATCH', 'CORRUPT_PDF',
    'PDF_PAGE_LIMIT_EXCEEDED', 'PDF_PAGE_COUNT_INVALID', 'IMAGE_MALFORMED', 'IMAGE_DIMENSIONS_EXCEEDED',
    'IMAGE_PIXELS_EXCEEDED', 'RASTER_DPI_OUT_OF_RANGE', 'RASTER_DIMENSIONS_EXCEEDED',
    'RASTER_PIXELS_EXCEEDED', 'RASTER_TOTAL_PIXELS_EXCEEDED', 'RASTERIZATION_FAILED',
    'TEXT_CHARACTER_LIMIT_EXCEEDED', 'TEXT_BLOCK_LIMIT_EXCEEDED', 'TEXT_LINE_LIMIT_EXCEEDED',
    'PDF_TEXT_OBJECT_LIMIT_EXCEEDED', 'STAGING_PATH_INVALID', 'STAGING_PATH_TRAVERSAL', 'STAGED_FILE_NOT_FOUND',
    'STAGED_PATH_NOT_FILE', 'OCR_PROVIDER_UNAVAILABLE', 'OCR_PROVIDER_FAILED', 'OCR_PROVIDER_OUTPUT_INVALID',
    'OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED', 'OCR_EMPTY_OUTPUT', 'INTERNAL_ERROR',
  ]),
  message: nonBlankString(PHASE_1_EXTRACTION_LIMITS.maxMessageCharacters),
}).strict();

/** Strict, versioned consumer for assistive-document-extraction/v1 worker output. */
export const phase1ExtractionResultSchema = z.object({
  schema_version: z.literal('assistive-document-extraction/v1'),
  status: extractionStatusSchema,
  source: extractionSourceSchema,
  document_type: documentTypeSchema.nullable(),
  page_count: z.number().int().min(0).max(PHASE_1_EXTRACTION_LIMITS.maxPages),
  text: z.string().max(PHASE_1_EXTRACTION_LIMITS.maxExtractedCharacters),
  blocks: z.array(textBlockSchema).max(PHASE_1_EXTRACTION_LIMITS.maxTextBlocks),
  native_quality: nativeQualitySchema,
  quality_evidence: qualityEvidenceSchema.nullable(),
  ocr_state: ocrStateSchema,
  provider: providerSchema.nullable(),
  warnings: z.array(warningSchema).max(PHASE_1_EXTRACTION_LIMITS.maxWarnings),
  error: errorSchema.nullable(),
}).strict().superRefine((result, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (result.blocks.reduce((sum, block) => sum + block.text.length, 0) > PHASE_1_EXTRACTION_LIMITS.maxExtractedCharacters) {
    issue('Text block output exceeds the Phase 1 character limit.');
  }
  if (result.status === 'FAILED' && result.error === null) issue('Failed extraction requires an error.');
  if (result.status !== 'FAILED' && result.error !== null) issue('Only failed extraction may carry an error.');
  if (result.status === 'COMPLETED' && (result.source === 'NONE' || result.page_count < 1 || !result.text.trim())) {
    issue('Completed extraction requires a source, page, and text.');
  }
  if (result.status === 'OCR_REQUIRED' && result.page_count < 1) issue('OCR_REQUIRED requires a page.');
  if (result.ocr_state === 'COMPLETED' && (result.provider === null || result.source !== 'OCR')) {
    issue('Completed OCR requires provider metadata and OCR source.');
  }
  if (result.source === 'OCR' && result.ocr_state !== 'COMPLETED') issue('OCR source requires completed OCR.');
  if (result.source === 'NATIVE_PDF' && result.document_type !== 'PDF') issue('Native PDF source requires a PDF.');
  if (result.source === 'NONE' && result.blocks.length > 0) issue('Source-less extraction cannot contain blocks.');
  if (result.status === 'OCR_REQUIRED' && !['REQUIRED_NOT_RUN', 'UNAVAILABLE'].includes(result.ocr_state)) {
    issue('OCR_REQUIRED must be pending or unavailable.');
  }
  if (result.blocks.some((block) => block.page_number > result.page_count)) issue('Text block page exceeds page count.');
  if (result.blocks.some((block) => block.source !== result.source)) issue('Text block source must match result source.');
});

export type Phase1ExtractionResult = z.infer<typeof phase1ExtractionResultSchema>;
export type Phase1TextBlock = Phase1ExtractionResult['blocks'][number];
export type Phase1BoundingBox = NonNullable<Phase1TextBlock['bounding_box']>;

/** Throws on unknown, malformed, oversized, or impossible worker output. */
export function parsePhase1ExtractionResult(input: unknown): Phase1ExtractionResult {
  return phase1ExtractionResultSchema.parse(input);
}
