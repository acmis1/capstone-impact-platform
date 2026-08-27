import {
  CANONICAL_MATCHABLE_FIELDS,
  CANONICAL_COMPARABLE_FIELDS,
  CanonicalMatchableField,
  CanonicalComparableField,
} from './adminReferenceSharedContract';

/**
 * Normalizes header strings by trimming whitespace, lowercasing, converting hyphens and
 * underscores to spaces, and collapsing consecutive whitespace characters.
 */
export function normalizeSpreadsheetHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Contract-backed alias dictionary mapping canonical project fields to legitimate synonym strings.
 * All alias entries are normalized before comparison. Sourced strictly from repository contracts.
 */
export const CANONICAL_FIELD_ALIASES: Record<string, string[]> = {
  publicId: ['project id', 'public id', 'public_id'],
  title: ['project title', 'title', 'official project title', 'official title'],
  groupName: ['group name', 'groupname', 'group', 'team name', 'team/group name'],
  year: ['project year', 'academic year', 'year'],
  program: ['study program', 'studyprogram', 'program', 'degree program', 'study programme', 'programme'],
  studyProgram: ['study program', 'studyprogram', 'program', 'degree program', 'study programme', 'programme'],
  academicSupervisor: ['academic supervisor', 'academicsupervisor', 'supervisor'],
  industryPartner: ['industry partner', 'industrypartner', 'partner'],
  participantContactEmail: [
    'participant contact email',
    'participantcontactemail',
    'group contact email',
    'groupcontactemail',
    'participant email',
    'group email',
    'contact email',
  ],
  teamMembers: ['team members', 'teammembers', 'participants', 'team roster'],
};

export interface HeaderMatchResult {
  /** Confident, unambiguous matches: canonicalField -> raw spreadsheet header */
  matched: Record<string, string>;
  /** Canonical fields with no matching column found in worksheet headers */
  unmatched: string[];
  /** Canonical fields where multiple columns matched: canonicalField -> candidate raw headers */
  ambiguous: Record<string, string[]>;
}

export const ALL_CANONICAL_FIELDS: Array<CanonicalMatchableField | CanonicalComparableField> = Array.from(
  new Set<CanonicalMatchableField | CanonicalComparableField>([
    ...CANONICAL_MATCHABLE_FIELDS,
    ...CANONICAL_COMPARABLE_FIELDS,
  ])
);

/**
 * Pure deterministic matcher that compares spreadsheet headers against canonical project fields.
 *
 * Rules:
 * - Compares normalized strings against finite alias lists.
 * - No fuzzy similarity, Levenshtein, or positional fallback.
 * - A field is matched only if exactly one header matches unambiguously.
 * - If multiple headers match a single field, that field is marked ambiguous (never guessed).
 * - If a header matches multiple distinct fields (excluding program/studyProgram synonyms),
 *   it is marked ambiguous for those fields.
 */
export function matchSpreadsheetHeaders(headers: string[]): HeaderMatchResult {
  const matched: Record<string, string> = {};
  const unmatched: string[] = [];
  const ambiguous: Record<string, string[]> = {};

  // Map each canonical field to all headers that match its aliases
  const fieldCandidates = new Map<string, string[]>();

  for (const field of ALL_CANONICAL_FIELDS) {
    const aliases = (CANONICAL_FIELD_ALIASES[field] || [field]).map(normalizeSpreadsheetHeader);
    const candidateHeaders: string[] = [];

    for (const h of headers) {
      const normH = normalizeSpreadsheetHeader(h);
      if (aliases.includes(normH)) {
        if (!candidateHeaders.includes(h)) {
          candidateHeaders.push(h);
        }
      }
    }

    fieldCandidates.set(field, candidateHeaders);
  }

  // Identify fields with 0 candidates or > 1 candidates
  for (const [field, candidates] of fieldCandidates.entries()) {
    if (candidates.length === 0) {
      unmatched.push(field);
    } else if (candidates.length > 1) {
      ambiguous[field] = candidates;
    }
  }

  // For fields with exactly 1 candidate, check if another distinct field claimed the same column
  const singleCandidateFields = Array.from(fieldCandidates.entries()).filter(
    ([, c]) => c.length === 1
  );

  const headerClaims = new Map<string, string[]>();
  for (const [field, [hdr]] of singleCandidateFields) {
    const normHdr = normalizeSpreadsheetHeader(hdr);
    if (!headerClaims.has(normHdr)) {
      headerClaims.set(normHdr, []);
    }
    headerClaims.get(normHdr)!.push(field);
  }

  for (const [field, [hdr]] of singleCandidateFields) {
    const normHdr = normalizeSpreadsheetHeader(hdr);
    const claimingFields = headerClaims.get(normHdr) || [];

    // Allow program and studyProgram to share a column without conflict; otherwise conflict causes ambiguity
    const nonEquivalentClaims = claimingFields.filter(
      (f) => !(f === 'program' && field === 'studyProgram') && !(f === 'studyProgram' && field === 'program')
    );

    if (nonEquivalentClaims.length > 1) {
      ambiguous[field] = [hdr];
    } else if (!ambiguous[field]) {
      matched[field] = hdr;
    }
  }

  return {
    matched,
    unmatched,
    ambiguous,
  };
}

export interface AutoMatchDerivation {
  matchResult: HeaderMatchResult;
  isAllRequiredMatched: boolean;
  matchMappings: Array<{ canonicalField: string; referenceColumn: string }>;
  comparisonMappings: Array<{ canonicalField: string; referenceColumn: string }>;
}

/**
 * Derives default match (groupName) and comparison (title, program) mappings.
 * Unresolved fields are assigned empty strings and are never filled with unrelated positional fallbacks.
 */
export function deriveDefaultReferenceMappings(headers: string[]): AutoMatchDerivation {
  const matchResult = matchSpreadsheetHeaders(headers);
  const matched = matchResult.matched;

  const matchedGroupName = matched.groupName || '';
  const matchedTitle = matched.title || '';
  const matchedProgram = matched.program || matched.studyProgram || '';

  const isAllRequiredMatched =
    Boolean(matchedGroupName) && Boolean(matchedTitle) && Boolean(matchedProgram);

  const matchMappings = [
    {
      canonicalField: 'groupName',
      referenceColumn: matchedGroupName,
    },
  ];

  const comparisonMappings = [
    {
      canonicalField: 'title',
      referenceColumn: matchedTitle,
    },
    {
      canonicalField: 'program',
      referenceColumn: matchedProgram,
    },
  ];

  return {
    matchResult,
    isAllRequiredMatched,
    matchMappings,
    comparisonMappings,
  };
}
