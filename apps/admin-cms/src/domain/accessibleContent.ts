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

/**
 * The authoritative presence rule for accessible content, mirrored by every workflow gate
 * (workbook parsing, review readiness, approval, publication readiness, public-feed validation)
 * and by the SQL-side `btrim(coalesce(col, '')) = ''` checks in Migration 0025.
 */
export function isAccessibleContentPresent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
