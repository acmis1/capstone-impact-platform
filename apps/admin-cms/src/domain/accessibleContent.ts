/**
 * Accessible poster content required on every public-eligible project.
 *
 * `posterText` is the searchable/selectable full textual version of the meaningful content on the
 * poster. `accessibilityText` is the concise descriptive text alternative/context for the poster
 * image. The two serve different purposes and are deliberately never required to match.
 *
 * These values are staff-authored or imported from the project workbook. Nothing in this codebase
 * generates them — no OCR, no AI, no derivation from other fields. Future OCR assistance may only
 * ever populate a draft suggestion for staff to accept; it must never become publication authority.
 */

/**
 * Transport/storage safety ceilings — NOT content-quality rules.
 *
 * They exist so a single project row, participant-preview snapshot, and compiled public-feed record
 * stay bounded in size. They are deliberately generous: nothing here judges whether the prose is
 * complete, well written, or a faithful transcription of the poster. Staff own that judgement.
 */
export const ACCESSIBLE_CONTENT_LIMITS = {
  /** A dense A0 research poster transcribes well under this ceiling. */
  posterText: 20_000,
  /** A text alternative is a description, not a transcription. */
  accessibilityText: 2_000,
} as const;

export type AccessibleContentField = keyof typeof ACCESSIBLE_CONTENT_LIMITS;

/** Staff-facing labels, so every boundary reports the same name for the same field. */
export const ACCESSIBLE_CONTENT_LABELS: Record<AccessibleContentField, string> = {
  posterText: 'Poster full text',
  accessibilityText: 'Accessibility text',
};

/**
 * The authoritative presence rule for accessible content, mirrored by every workflow gate
 * (workbook parsing, review readiness, approval, publication readiness, public-feed validation)
 * and by the SQL-side `btrim(coalesce(col, '')) = ''` checks in Migration 0025.
 */
export function isAccessibleContentPresent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The authoritative bound rule, evaluated against the trimmed value so it matches what actually
 * gets persisted. Mirrored by the SQL-side `length(btrim(coalesce(col, ''))) > n` checks in
 * Migration 0025.
 *
 * A blank value is not "over the limit" — absence and oversize are distinct problems and each
 * boundary reports them separately, so staff are never told to shorten something that is missing.
 */
export function isAccessibleContentWithinLimit(
  value: string | null | undefined,
  field: AccessibleContentField,
): boolean {
  if (typeof value !== 'string') return true;
  return value.trim().length <= ACCESSIBLE_CONTENT_LIMITS[field];
}

export type AccessibleContentProblem = 'MISSING' | 'TOO_LONG';

/**
 * Single deterministic verdict for one accessible-content value, shared by the import staging
 * boundary, review readiness, approval validation and public-feed validation so those boundaries
 * can never drift apart.
 *
 * The only rules are: is it a string, is it non-empty after trim when required, and is the trimmed
 * length within the technical ceiling. Nothing here scores the prose — no word counts, no keyword
 * checks, no similarity to any other field, no OCR, no AI.
 */
export function getAccessibleContentProblem(
  value: string | null | undefined,
  field: AccessibleContentField,
  options: { required?: boolean } = {},
): AccessibleContentProblem | null {
  const required = options.required ?? true;
  if (!isAccessibleContentPresent(value)) return required ? 'MISSING' : null;
  if (!isAccessibleContentWithinLimit(value, field)) return 'TOO_LONG';
  return null;
}

/** Bounded staff-facing reason for a problem, used verbatim by readiness and approval blockers. */
export function describeAccessibleContentProblem(
  problem: AccessibleContentProblem,
  field: AccessibleContentField,
): string {
  const label = ACCESSIBLE_CONTENT_LABELS[field];
  return problem === 'MISSING'
    ? `${label} is missing.`
    : `${label} exceeds the ${ACCESSIBLE_CONTENT_LIMITS[field].toLocaleString('en-US')} character safety limit.`;
}
