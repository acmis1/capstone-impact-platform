import { z } from 'zod';

import {
  ASSISTIVE_LANGUAGE_EVIDENCE_VERSION,
  ASSISTIVE_LANGUAGE_POLICY_SHA256,
  ASSISTIVE_PIPELINE_VERSION,
  persistedAssistiveFindingSchema,
  type PersistedAssistiveFinding,
} from './persistenceContract';
import type { DuplicateProjectProse } from '../duplicate-detection/duplicateRanker';

export const LANGUAGE_PROVIDER_ID = 'LANGUAGETOOL' as const;
export const LANGUAGE_PROVIDER_VERSION = '6.6' as const;
export const LANGUAGE_TOOL_ARCHIVE_SHA256 =
  '53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631';
export const LANGUAGE_TOOL_SERVER_JAR_SHA256 =
  'f5279d946d901c90c0bb09cddaa6fdea8b26db9c548145d09041e8d1ac2d2b45';

export const ASSISTIVE_LANGUAGE_LIMITS = {
  fieldsPerProject: 4,
  findingsPerField: 10,
  findingsPerProject: 20,
  providerMatchesPerField: 100,
  responseBytesPerField: 256_000,
  stderrBytes: 16_384,
  suggestionCodePoints: 100,
  suggestionsPerFinding: 3,
} as const;

export type AssistiveLanguageField = 'title' | 'summary' | 'background' | 'solution';

export const languageToolRawMatchSchema = z.object({
  offset: z.number().int().min(0).max(25_000),
  length: z.number().int().min(0).max(25_000),
  message: z.string().max(1_000),
  ruleId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  categoryId: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  replacements: z.array(z.string().max(500)).max(20),
}).strict();

export type LanguageToolRawMatch = z.infer<typeof languageToolRawMatchSchema>;

const APPROVED_TERMS = new Set([
  'API', 'Argon2id', 'Duda', 'F1', 'FastAPI', 'JSON', 'Java', 'LanguageTool', 'Modbus',
  'MQTT', 'Next.js', 'Node.js', 'npm', 'OCR', 'OpenAPI', 'OpenSearch', 'OpenTelemetry',
  'PDF', 'PKCE', 'PostgREST', 'PostgreSQL', 'Pydantic', 'RabbitMQ', 'Redis', 'SvelteKit',
  'Supabase', 'TypeScript', 'Turbopack', 'Unicode', 'UTF-16', 'UUID', 'Vitest', 'WebAuthn',
  'WebRTC', 'deidentified', 'loopback', 'projectMetadataHash',
]);

const MASK_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\r\n]+`/g,
  /https?:\/\/[^\s]+/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
  /\b(?:sha(?:1|224|256|384|512):)?[0-9a-fA-F]{32,128}\b/gi,
  /(?<!\w)(?:[A-Za-z]:[\\/]|\.?\.?[\\/])(?:[^\s<>:"|?*]+[\\/])*[^\s<>:"|?*]*/g,
  /\b[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\b/g,
  /\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b/g,
  /\bv?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?\b/g,
  /\b(?:[A-Z][A-Z0-9]*|[a-z][a-z0-9]*)(?:_[A-Za-z0-9]+)+\b/g,
  /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
];

interface MaskedLanguageText {
  text: string;
  spans: Array<{ start: number; end: number }>;
}

/** Mask machine identifiers with spaces while preserving LanguageTool's UTF-16 code-unit offsets. */
export function maskLanguageText(source: string): MaskedLanguageText {
  const masked = source.split('');
  const spans: Array<{ start: number; end: number }> = [];
  for (const pattern of MASK_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (spans.some((span) => span.start < end && start < span.end)) continue;
      spans.push({ start, end });
      for (let index = start; index < end; index += 1) {
        if (masked[index] !== '\r' && masked[index] !== '\n') masked[index] = ' ';
      }
    }
  }
  const text = masked.join('');
  if (text.length !== source.length) throw new Error('LANGUAGE_MASK_OFFSET_DRIFT');
  return { text, spans: spans.sort((left, right) => left.start - right.start) };
}

/** Converts a provider UTF-16 code-unit boundary to the canonical Unicode code-point unit. */
export function utf16OffsetToCodePoint(source: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    throw new Error('LANGUAGE_OFFSET_OUT_OF_RANGE');
  }
  if (offset > 0 && offset < source.length) {
    const previous = source.charCodeAt(offset - 1);
    const current = source.charCodeAt(offset);
    if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) {
      throw new Error('LANGUAGE_OFFSET_SPLITS_SURROGATE');
    }
  }
  return Array.from(source.slice(0, offset)).length;
}

function damerauLevenshtein(leftValue: string, rightValue: string): number {
  const left = Array.from(leftValue.toLocaleLowerCase('en-AU'));
  const right = Array.from(rightValue.toLocaleLowerCase('en-AU'));
  const distances = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let index = 0; index <= left.length; index += 1) distances[index][0] = index;
  for (let index = 0; index <= right.length; index += 1) distances[0][index] = index;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        distances[i][j] = Math.min(distances[i][j], distances[i - 2][j - 2] + cost);
      }
    }
  }
  return distances[left.length][right.length];
}

function isSpelling(match: LanguageToolRawMatch): boolean {
  const evidence = `${match.ruleId} ${match.categoryId}`.toLowerCase();
  return ['spell', 'morfologik', 'dictionary', 'numbers_in_words'].some((marker) => evidence.includes(marker))
    || match.categoryId.toUpperCase() === 'TYPOS';
}

function technicalShape(token: string): boolean {
  return Array.from(token).some((character) => character.codePointAt(0)! > 127)
    || (Array.from(token).length <= 2 && token === token.toLowerCase())
    || /^[A-Za-z0-9]*[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(token)
    || /^(?=.*[A-Z0-9])[A-Z0-9]{2,}$/.test(token);
}

function punctuationShape(value: string): string {
  return Array.from(value).filter((character) => !/[\p{L}\p{N}\s]/u.test(character)).join('');
}

function boundedProviderReplacements(replacements: readonly string[]): string[] {
  const retained: string[] = [];
  for (const raw of replacements) {
    if (!raw || Array.from(raw).length > ASSISTIVE_LANGUAGE_LIMITS.suggestionCodePoints
      || /[\u0000-\u001F]/.test(raw)
      || retained.includes(raw)) continue;
    retained.push(raw);
    if (retained.length === ASSISTIVE_LANGUAGE_LIMITS.suggestionsPerFinding) break;
  }
  return retained;
}

function plausibleSpellingSuggestions(token: string, replacements: readonly string[]): string[] {
  const retained: string[] = [];
  const maximumDistance = Array.from(token).length >= 9 ? 2 : 1;
  for (const raw of replacements) {
    const suggestion = raw.trim();
    if (!suggestion || /\u007F/.test(suggestion) || (
      (/\s/u.test(token) !== /\s/u.test(suggestion))
      || punctuationShape(token) !== punctuationShape(suggestion)
      || damerauLevenshtein(token, suggestion) > maximumDistance
    )) continue;
    if (!retained.includes(suggestion)) retained.push(suggestion);
  }
  return retained;
}

function persistenceSafeGrammarSuggestions(replacements: readonly string[]): string[] {
  return replacements.filter((replacement) => replacement.trim().length > 0 && !/\u007F/.test(replacement));
}

function uniqueApprovedNearMiss(token: string): string | null {
  if (Array.from(token).length < 5) return null;
  const matches = [...APPROVED_TERMS].filter((term) => damerauLevenshtein(token, term) <= 1);
  return matches.length === 1 ? matches[0] : null;
}

function reasonFor(match: LanguageToolRawMatch): PersistedAssistiveFinding['reasonCode'] {
  const evidence = `${match.ruleId} ${match.categoryId}`.toUpperCase();
  if (isSpelling(match)) return 'LANGUAGE_SPELLING';
  if (evidence.includes('REPEAT')) return 'LANGUAGE_REPEATED_WORD';
  if (evidence.includes('PUNCT') || evidence.includes('COMMA')) return 'LANGUAGE_PUNCTUATION';
  if (evidence.includes('CASING') || evidence.includes('UPPERCASE') || evidence.includes('CAPITAL')) {
    return 'LANGUAGE_CAPITALIZATION';
  }
  return 'LANGUAGE_GRAMMAR';
}

function contextExcerpt(source: string, start: number, end: number): string {
  const codePoints = Array.from(source);
  return codePoints.slice(Math.max(0, start - 80), Math.min(codePoints.length, end + 80))
    .slice(0, 500).join('').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD');
}

function boundedExplanation(message: string): string {
  const generic = 'LanguageTool identified a possible language issue. Review the source span and choose a suggestion only if it preserves the intended meaning.';
  const plainText = Array.from(message).slice(0, 300).join('')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD')
    .replaceAll('<', '\u2039')
    .replaceAll('>', '\u203A')
    .trim();
  return plainText || generic;
}

export function toPersistedLanguageFindings(input: {
  field: AssistiveLanguageField;
  source: string;
  inputHash: string;
  matches: readonly LanguageToolRawMatch[];
}): PersistedAssistiveFinding[] {
  const masked = maskLanguageText(input.source);
  const findings: PersistedAssistiveFinding[] = [];
  for (const raw of input.matches.slice(0, ASSISTIVE_LANGUAGE_LIMITS.providerMatchesPerField)) {
    const match = languageToolRawMatchSchema.parse(raw);
    const utf16End = match.offset + match.length;
    if (utf16End > input.source.length
      || masked.spans.some((span) => span.start < utf16End && match.offset < span.end)) continue;
    const spelling = isSpelling(match);
    if (input.field === 'title' && !spelling) continue;
    const token = input.source.slice(match.offset, utf16End);
    if (spelling && APPROVED_TERMS.has(token)) continue;
    const trusted = spelling ? uniqueApprovedNearMiss(token) : null;
    if (spelling && !trusted && technicalShape(token)) continue;
    const bounded = boundedProviderReplacements(match.replacements);
    const suggestions = trusted
      ? [trusted]
      : spelling ? plausibleSpellingSuggestions(token, bounded) : persistenceSafeGrammarSuggestions(bounded);
    if (spelling && suggestions.length === 0) continue;
    const startOffset = utf16OffsetToCodePoint(input.source, match.offset);
    const endOffset = utf16OffsetToCodePoint(input.source, utf16End);
    const reasonCode = reasonFor(match);
    findings.push(persistedAssistiveFindingSchema.parse({
      checkType: 'LANGUAGE_SUGGESTION',
      outcome: 'REVIEW',
      classification: 'NON_BLOCKING',
      reasonCode,
      affectedField: input.field,
      origin: 'LOCAL_LANGUAGE_PROVIDER',
      scoreKind: null,
      scoreValue: null,
      evidence: {
        version: ASSISTIVE_LANGUAGE_EVIDENCE_VERSION,
        startOffset,
        endOffset,
        offsetUnit: 'UNICODE_CODE_POINTS',
        originalSourceSpan: token,
        contextExcerpt: contextExcerpt(input.source, startOffset, endOffset),
        languageCategory: match.categoryId,
        ruleId: match.ruleId,
        providerId: LANGUAGE_PROVIDER_ID,
        providerVersion: LANGUAGE_PROVIDER_VERSION,
        suggestions,
        explanation: boundedExplanation(match.message),
        inputHash: input.inputHash,
        pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        policySha256: ASSISTIVE_LANGUAGE_POLICY_SHA256,
      },
    }));
    if (findings.length === ASSISTIVE_LANGUAGE_LIMITS.findingsPerField) break;
  }
  return findings;
}

export function languageFields(project: DuplicateProjectProse): Array<{
  field: AssistiveLanguageField;
  source: string;
}> {
  return (['title', 'summary', 'background', 'solution'] as const)
    .map((field) => ({ field, source: project[field] }));
}
