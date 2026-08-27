import type { AssistiveCheckResult } from '../domain/evidence';
import { ASSISTIVE_EVIDENCE_LIMITS, createAssistiveCheckResult, sanitizeAssistivePlainText } from '../domain/evidence';
import type { Phase1ExtractionResult } from '../domain/extractionContract';
import { normalizeFrozenTitle, selectOcrTitleCandidates } from './ocrTitleSelector';
import { extractTitleCandidates, type TitleCandidate } from './titleCandidates';
import { normalizeTitle } from './normalization';

export interface TitleConsistencyPolicy {
  /** Explicitly approved alternate document titles. There is no default subtitle or alias policy. */
  allowedCandidateTitles?: readonly string[];
}

function tokens(value: string): string[] {
  return normalizeTitle(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function levenshtein(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] = Math.min(row[rightIndex] + 1, row[rightIndex - 1] + 1, diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

function lexicalScore(metadata: string, candidate: string): number {
  const left = normalizeTitle(metadata);
  const right = normalizeTitle(candidate);
  const edit = 1 - levenshtein(left, right) / Math.max(1, left.length, right.length);
  const leftTokens = new Set(tokens(metadata));
  const rightTokens = new Set(tokens(candidate));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const dice = leftTokens.size + rightTokens.size === 0 ? 0 : (2 * shared) / (leftTokens.size + rightTokens.size);
  return Number(((edit + dice) / 2).toFixed(3));
}

function isLikelyNoiseOrVariant(metadata: string, candidate: string): boolean {
  const left = tokens(metadata);
  const right = tokens(candidate);
  if (left.length !== right.length) return false;
  const differences = left.map((token, index) => [token, right[index]] as const).filter(([a, b]) => a !== b);
  if (differences.length !== 1) return false;
  const [a, b] = differences[0];
  if (a.startsWith(b) || b.startsWith(a)) return /(?:ing|er|or|re|s|es)$/.test(a) || /(?:ing|er|or|re|s|es)$/.test(b);
  if (levenshtein(a, b) !== 1) return false;
  const pairs = new Set(['il', 'li', 'o0', '0o', 'i1', '1i', 'sz', 'zs']);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index] && pairs.has(`${a[index]}${b[index]}`)) return true;
  }
  return false;
}

function isMaterialMismatch(metadata: string, candidate: string): boolean {
  if (isLikelyNoiseOrVariant(metadata, candidate)) return false;
  const left = new Set(tokens(metadata));
  const right = new Set(tokens(candidate));
  const shared = [...left].filter((token) => right.has(token)).length;
  const dice = left.size + right.size === 0 ? 0 : (2 * shared) / (left.size + right.size);
  return dice <= 0.8 || lexicalScore(metadata, candidate) <= 0.65;
}

function independentAmbiguity(candidates: readonly TitleCandidate[]): boolean {
  if (candidates.length < 2) return false;
  const first = new Set(candidates[0].blockIndexes);
  return candidates.slice(1, 3).some((candidate) => candidate.blockIndexes.every((index) => !first.has(index))
    && candidate.prominence >= candidates[0].prominence * 0.85);
}

function baseResult(
  outcome: AssistiveCheckResult['outcome'],
  reasonCode: AssistiveCheckResult['reasonCode'],
  explanation: string,
  metadataTitle: string | null,
  candidate: TitleCandidate | null,
  score: number | null,
): AssistiveCheckResult {
  return createAssistiveCheckResult({
    checkType: 'TITLE_CONSISTENCY', outcome, classification: 'NON_BLOCKING', reasonCode, affectedField: 'title',
    origin: 'PHASE_1_EXTRACTION', evidenceExcerpt: candidate?.text ?? null, pageNumber: candidate?.pageNumber ?? null,
    boundingBox: candidate?.boundingBox ?? null, metadataValue: metadataTitle === null ? null : sanitizeAssistivePlainText(metadataTitle, ASSISTIVE_EVIDENCE_LIMITS.value),
    normalizedMetadataValue: metadataTitle === null ? null : sanitizeAssistivePlainText(normalizeTitle(metadataTitle), ASSISTIVE_EVIDENCE_LIMITS.value),
    candidateValue: candidate?.text ?? null, normalizedCandidateValue: candidate === null ? null : normalizeTitle(candidate.text),
    lexicalScore: score, explanation,
  });
}

export function evaluateTitleConsistency(
  extraction: Phase1ExtractionResult,
  metadataTitle: string | null | undefined,
  policy: TitleConsistencyPolicy = {},
): AssistiveCheckResult {
  if (extraction.status === 'FAILED') return baseResult('NOT_EVALUATED', 'EXTRACTION_FAILED', 'Document extraction failed; title consistency was not evaluated.', null, null, null);
  if (extraction.status === 'OCR_REQUIRED') {
    const unavailable = extraction.ocr_state === 'UNAVAILABLE';
    return baseResult('NOT_EVALUATED', unavailable ? 'OCR_PROVIDER_UNAVAILABLE' : 'OCR_REQUIRED_NOT_RUN', unavailable
      ? 'OCR is required but the explicitly selected provider is unavailable.'
      : 'OCR is required but has not run; title consistency was not evaluated.', null, null, null);
  }
  if (!metadataTitle?.trim()) return baseResult('NOT_EVALUATED', 'METADATA_TITLE_ABSENT', 'Metadata title is absent; existing authoritative validation owns that requirement.', null, null, null);
  const fromOcr = extraction.source === 'OCR';
  const candidates = fromOcr ? selectOcrTitleCandidates(extraction) : extractTitleCandidates(extraction);
  const provenance = fromOcr ? ` ${providerEvidence(extraction)}` : '';
  const explain = (text: string) => `${text}${provenance}`.slice(0, ASSISTIVE_EVIDENCE_LIMITS.explanation);
  if (candidates.length === 0) return baseResult('NOT_EVALUATED', 'NO_CREDIBLE_TITLE_CANDIDATE', explain('Completed extraction did not provide a credible title candidate.'), metadataTitle, null, null);
  const candidate = candidates[0];
  const score = lexicalScore(metadataTitle, candidate.text);
  const normalizedCandidate = normalizeTitle(candidate.text);
  // The frozen OCR classifier settles normalized exact equality before ambiguity.
  if (fromOcr && normalizeFrozenTitle(metadataTitle) === normalizeFrozenTitle(candidate.text)) {
    return baseResult('AGREES', 'NORMALIZED_EXACT_MATCH', explain('Title matches by deterministic normalized equality.'), metadataTitle, candidate, score);
  }
  if (independentAmbiguity(candidates)) return baseResult('REVIEW', 'AMBIGUOUS_TITLE_CANDIDATES', explain('Multiple independent title candidates are similarly prominent; staff review is required.'), metadataTitle, candidate, score);
  if (normalizeTitle(metadataTitle) === normalizedCandidate) return baseResult('AGREES', 'NORMALIZED_EXACT_MATCH', explain('Title matches by deterministic normalized equality.'), metadataTitle, candidate, score);
  if ((policy.allowedCandidateTitles ?? []).some((title) => normalizeTitle(title) === normalizedCandidate)) {
    return baseResult('AGREES', 'EXPLICIT_POLICY_MATCH', explain('Title matches an explicitly supplied policy value.'), metadataTitle, candidate, score);
  }
  if (isMaterialMismatch(metadataTitle, candidate.text)) return baseResult('MISMATCH', 'MATERIAL_TOKEN_DIFFERENCE', explain('Document title contains a material token difference; it remains non-blocking.'), metadataTitle, candidate, score);
  return baseResult('REVIEW', 'POSSIBLE_OCR_OR_SPELLING_VARIANT', explain('Title is not an exact normalized match and may reflect OCR or spelling variation; staff review is required.'), metadataTitle, candidate, score);
}

function providerEvidence(extraction: Phase1ExtractionResult): string {
  const provider = extraction.provider;
  if (!provider) return 'Poster text was recognised by an unnamed local OCR provider.';
  const parts = [
    provider.provider_id,
    provider.model_version,
    provider.provider_version,
    provider.runtime_version,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return `Poster text was recognised by ${parts.join(', ')}.`;
}
