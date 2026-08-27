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
 * Alias dictionary for deterministic header matching.
 *
 * Every entry is backed by existing repository evidence of exactly two kinds:
 *
 * (a) the published accepted-alias table for staff spreadsheets in
 *     `projectDetailsWorkbookContract.ts` (mirrored in
 *     `docs/project-details-workbook-contract.md`); and
 * (b) header spellings that already appear in committed School reference workbook fixtures,
 *     cited per entry below.
 *
 * Nothing here is a guessed or invented synonym. Comparison stays exact after normalization -
 * no fuzzy similarity and no positional inference - so any header not listed here stays
 * unresolved and a human decides.
 */
export const CANONICAL_FIELD_ALIASES: Record<string, string[]> = {
  // (b) `Public ID` is the reference-workbook header in `fixtures/syntheticImportPackages.ts`;
  //     `Project ID` is this application's own staff-facing label for the field. `public_id`
  //     normalizes to `public id`.
  publicId: ['project id', 'public id', 'public_id'],
  // (a) `project title`, `title`.
  // (b) `Official Project Title` in `browserImportPreview.test.ts` and
  //     `adminReferenceClientBoundary.test.ts`; `Official Title` in the import client fixtures.
  title: ['project title', 'title', 'official project title', 'official title'],
  // (a) `group name`, `groupname`.
  groupName: ['group name', 'groupname'],
  // (a) `project year`, `projectyear`, `year`.
  // (b) `Academic Year` in `browserImportMetadataStage.test.ts`.
  year: ['project year', 'projectyear', 'year', 'academic year'],
  // (a) `study program`, `studyprogram`, `program`.
  // (b) `Degree Program` in `browserImportPreview.test.ts`.
  program: ['study program', 'studyprogram', 'program', 'degree program'],
  // Same evidence as `program`: the workbook contract maps that one staff column onto both the
  // `program` and `studyProgram` internal fields.
  studyProgram: ['study program', 'studyprogram', 'program', 'degree program'],
  // (a) `academic supervisor`, `academicsupervisor`, `supervisor`.
  academicSupervisor: ['academic supervisor', 'academicsupervisor', 'supervisor'],
  // (a) `industry partner`, `industrypartner`.
  industryPartner: ['industry partner', 'industrypartner'],
  // (a) all seven aliases published for the participant contact email column.
  participantContactEmail: [
    'participant contact email',
    'participantcontactemail',
    'group contact email',
    'groupcontactemail',
    'participant email',
    'group email',
    'contact email',
  ],
  // (a) `team members`, `teammembers`, `participants`.
  // (b) `Team Roster` in `adminReferenceReconciliation.test.ts`.
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

export interface ReferenceMapping {
  canonicalField: string;
  referenceColumn: string;
}

export interface ReferenceMappingSet {
  matchMappings: ReferenceMapping[];
  comparisonMappings: ReferenceMapping[];
}

/**
 * Deterministic structural comparison of two mapping configurations, order included.
 *
 * The import UI uses this to decide whether the mappings currently on screen are still exactly the
 * automatic suggestion, or have been edited by hand. Restoring the automatic mapping by hand
 * compares equal again, so the configuration is reclassified as automatic rather than staying
 * permanently marked as manual.
 */
export function referenceMappingSetsEqual(a: ReferenceMappingSet, b: ReferenceMappingSet): boolean {
  const sameList = (left: ReferenceMapping[], right: ReferenceMapping[]) =>
    left.length === right.length &&
    left.every(
      (mapping, index) =>
        mapping.canonicalField === right[index].canonicalField &&
        mapping.referenceColumn === right[index].referenceColumn,
    );

  return (
    sameList(a.matchMappings, b.matchMappings) &&
    sameList(a.comparisonMappings, b.comparisonMappings)
  );
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
