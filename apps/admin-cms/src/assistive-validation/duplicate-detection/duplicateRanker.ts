import { createHash } from 'node:crypto';

export const DUPLICATE_SHORTLIST_LIMITS = {
  candidatePool: 1_000,
  shortlist: 5,
  publicId: 100,
  title: 200,
  summary: 1_000,
  background: 10_000,
  solution: 10_000,
  summaryExcerpt: 240,
  /**
   * Only canonical equality scores 1. Every other comparison is capped here, so a persisted score
   * of exactly 1 is a durable claim that the two canonical texts were identical.
   */
  inexactScoreCeiling: 0.999,
} as const;

export interface DuplicateProjectProse {
  publicId: string;
  title: string;
  summary: string;
  background: string;
  solution: string;
}

export interface RankedDuplicateCandidate {
  rank: number;
  publicId: string;
  title: string;
  summaryExcerpt: string;
  lexicalScore: number;
  exactContentMatch: boolean;
  normalizedTitleMatch: boolean;
}

const DASHES = /[\u2010-\u2015]/g;
const LEFT_SINGLE_QUOTE = /[\u2018\u201A]/g;
const RIGHT_SINGLE_QUOTE = /\u2019/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E]/g;

/** Phase 6A lexical normalization, ported from the frozen Python benchmark. */
export function normalizeDuplicateText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(LEFT_SINGLE_QUOTE, "'")
    .replace(RIGHT_SINGLE_QUOTE, "'")
    .replace(DOUBLE_QUOTES, '"')
    .toLocaleLowerCase('en')
    .replace(/\u00df/g, 'ss')
    .replace(/\u03c2/g, '\u03c3')
    .replace(/[-_/]/g, ' ')
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function projectText(project: DuplicateProjectProse): string {
  return [project.summary, project.background, project.solution].join('\n');
}

export function canonicalDuplicateText(project: DuplicateProjectProse): string {
  return `${normalizeDuplicateText(project.title)}\n${normalizeDuplicateText(projectText(project))}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / Math.max(1, new Set([...leftTokens, ...rightTokens]).size);
}

function trigrams(text: string): Map<string, number> {
  const normalized = normalizeDuplicateText(text);
  const padded = [...`  ${normalized}  `];
  const result = new Map<string, number>();
  for (let index = 0; index < Math.max(0, padded.length - 2); index += 1) {
    const token = padded.slice(index, index + 3).join('');
    result.set(token, (result.get(token) ?? 0) + 1);
  }
  return result;
}

function trigramCosine(left: Map<string, number>, right: Map<string, number>): number {
  let numerator = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (const count of left.values()) leftSquared += count * count;
  for (const count of right.values()) rightSquared += count * count;
  for (const [token, count] of left) numerator += count * (right.get(token) ?? 0);
  const denominator = Math.sqrt(leftSquared) * Math.sqrt(rightSquared);
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Bounded copy of candidate prose that never ends on an orphaned high surrogate, so the truncated
 * value stays encodable as UTF-8 text for both storage and the browser.
 */
export function boundedDuplicateEvidenceText(value: string, maximum: number): string {
  const excerpt = value.slice(0, maximum);
  return /[\uD800-\uDBFF]$/.test(excerpt) ? excerpt.slice(0, -1) : excerpt;
}

export function hashDuplicateCorpus(candidates: readonly DuplicateProjectProse[]): string {
  if (candidates.length > DUPLICATE_SHORTLIST_LIMITS.candidatePool) {
    throw new Error('DUPLICATE_CANDIDATE_POOL_LIMIT_EXCEEDED');
  }
  const sorted = [...candidates].sort((left, right) => comparePublicIds(left.publicId, right.publicId));
  if (new Set(sorted.map((candidate) => candidate.publicId)).size !== sorted.length) {
    throw new Error('DUPLICATE_CANDIDATE_PUBLIC_ID_CONFLICT');
  }
  const canonical = JSON.stringify(sorted.map((candidate) => ({
    publicId: candidate.publicId,
    title: candidate.title,
    summary: candidate.summary,
    background: candidate.background,
    solution: candidate.solution,
  })));
  return sha256(canonical);
}

/**
 * Pure Phase 6A ranker. Scores are lexical diagnostics only and never duplicate classifications.
 */
export function rankDuplicateCandidates(
  current: DuplicateProjectProse,
  candidatePool: readonly DuplicateProjectProse[],
): RankedDuplicateCandidate[] {
  if (candidatePool.length > DUPLICATE_SHORTLIST_LIMITS.candidatePool) {
    throw new Error('DUPLICATE_CANDIDATE_POOL_LIMIT_EXCEEDED');
  }

  const queryCanonical = canonicalDuplicateText(current);
  const queryHash = sha256(queryCanonical);
  const queryTrigrams = trigrams(queryCanonical);
  const queryTitle = normalizeDuplicateText(current.title);

  return candidatePool
    .filter((candidate) => candidate.publicId !== current.publicId)
    .map((candidate) => {
      const canonical = canonicalDuplicateText(candidate);
      const exactContentMatch = sha256(canonical) === queryHash;
      const normalizedTitleMatch = normalizeDuplicateText(candidate.title) === queryTitle;
      const lexicalScore = exactContentMatch
        ? 1
        : Math.min(
          DUPLICATE_SHORTLIST_LIMITS.inexactScoreCeiling,
          0.25 * Number(normalizedTitleMatch)
            + 0.40 * tokenJaccard(queryCanonical, canonical)
            + 0.35 * trigramCosine(queryTrigrams, trigrams(canonical)),
        );
      return {
        publicId: candidate.publicId,
        title: candidate.title,
        summaryExcerpt: boundedDuplicateEvidenceText(candidate.summary, DUPLICATE_SHORTLIST_LIMITS.summaryExcerpt),
        lexicalScore,
        exactContentMatch,
        normalizedTitleMatch,
      };
    })
    .sort((left, right) => right.lexicalScore - left.lexicalScore
      || comparePublicIds(left.publicId, right.publicId))
    .slice(0, DUPLICATE_SHORTLIST_LIMITS.shortlist)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/** Route-safe public IDs are ASCII, so code-unit order is the deterministic tie breaker. */
export function comparePublicIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
