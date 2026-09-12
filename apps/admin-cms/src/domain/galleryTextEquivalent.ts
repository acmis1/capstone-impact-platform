import {
  ACCESSIBLE_CONTENT_LIMITS,
  getAccessibleContentProblem,
  isAccessibleContentPresent,
} from './accessibleContent';

/** Same normalisation the workbook contract applies to option cells (case, hyphens, spacing). */
function normalizeOptionCell(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Explicit, project-team-declared classification of one snapshot/gallery image.
 *
 * The brief requires every project page to carry a full text version of ALL image content. A
 * short alt description satisfies that for an ordinary photograph, but not for a screenshot,
 * slide, diagram, chart or infographic whose meaningful content is text. The classification
 * decides which rule applies and is therefore authoritative data in its own right: nothing in
 * this codebase infers it from a filename, from OCR evidence, from the length of the alt text or
 * from anything an AI service produced. Absence (`null`) means "not yet declared", which every
 * workflow gate treats as a blocker — never as "ordinary".
 *
 * Mirrored by the `image_content_kind` column and its check constraint in Migration 0057.
 */
export type SnapshotImageContentKind = 'ordinary' | 'text_bearing';

export const SNAPSHOT_IMAGE_CONTENT_KINDS: readonly SnapshotImageContentKind[] = [
  'ordinary',
  'text_bearing',
] as const;

export function isSnapshotImageContentKind(value: unknown): value is SnapshotImageContentKind {
  return value === 'ordinary' || value === 'text_bearing';
}

/**
 * Bounded vocabulary accepted in the workbook "content type" column. Deliberately small and
 * explicit: each phrase is the project team stating the classification, not describing the image.
 * An unrecognised value is an error at the parser, never a silent default.
 */
const CONTENT_KIND_VOCABULARY: Record<string, SnapshotImageContentKind> = {
  'ordinary': 'ordinary',
  'ordinary image': 'ordinary',
  'ordinary photograph': 'ordinary',
  'photo': 'ordinary',
  'photograph': 'ordinary',
  'descriptive': 'ordinary',
  'descriptive image': 'ordinary',
  'no meaningful text': 'ordinary',
  'text bearing': 'text_bearing',
  'text bearing image': 'text_bearing',
  'text': 'text_bearing',
  'contains text': 'text_bearing',
  'contains meaningful text': 'text_bearing',
  'informational': 'text_bearing',
  'information rich': 'text_bearing',
};

export type SnapshotImageContentKindParse =
  | { status: 'blank' }
  | { status: 'unrecognized' }
  | { status: 'parsed'; contentKind: SnapshotImageContentKind };

/** Parses one workbook cell into a classification, or reports that it is blank or unrecognised. */
export function parseSnapshotImageContentKind(raw: string | null | undefined): SnapshotImageContentKindParse {
  const normalized = normalizeOptionCell(raw ?? '');
  if (normalized === '') return { status: 'blank' };
  const contentKind = CONTENT_KIND_VOCABULARY[normalized];
  return contentKind ? { status: 'parsed', contentKind } : { status: 'unrecognized' };
}

/**
 * One deterministic verdict for the text-equivalent state of a snapshot image, shared by the
 * package boundary, review readiness, approval validation, publication planning and public-feed
 * validation. Mirrored by the SQL gates forward-redefined in Migration 0057.
 *
 * - `CONTENT_KIND_MISSING`: the image has not been classified (legacy row or blank cell).
 * - `FULL_TEXT_MISSING`:    a text-bearing image has no full textual equivalent.
 * - `FULL_TEXT_TOO_LONG`:   a full text is present but beyond the technical ceiling.
 * - `FULL_TEXT_UNEXPECTED`: an ordinary image carries a full text. The two statements contradict
 *                           each other, so the package is sent back rather than one being guessed.
 */
export type SnapshotTextEquivalentProblem =
  | 'CONTENT_KIND_MISSING'
  | 'FULL_TEXT_MISSING'
  | 'FULL_TEXT_TOO_LONG'
  | 'FULL_TEXT_UNEXPECTED';

export interface SnapshotTextEquivalentInput {
  contentKind: SnapshotImageContentKind | null | undefined;
  fullText: string | null | undefined;
}

export function getSnapshotTextEquivalentProblem(
  input: SnapshotTextEquivalentInput,
): SnapshotTextEquivalentProblem | null {
  const fullTextPresent = isAccessibleContentPresent(input.fullText);
  if (fullTextPresent && getAccessibleContentProblem(input.fullText, 'snapshotFullText') === 'TOO_LONG') {
    return 'FULL_TEXT_TOO_LONG';
  }
  if (!isSnapshotImageContentKind(input.contentKind)) return 'CONTENT_KIND_MISSING';
  if (input.contentKind === 'text_bearing') return fullTextPresent ? null : 'FULL_TEXT_MISSING';
  return fullTextPresent ? 'FULL_TEXT_UNEXPECTED' : null;
}

/**
 * Staff-facing reason, always naming the gallery position so review and readiness surfaces can
 * point at the exact image the project team must correct in the source package.
 */
export function describeSnapshotTextEquivalentProblem(
  problem: SnapshotTextEquivalentProblem,
  galleryPosition: number | null,
): string {
  const image = galleryPosition === null ? 'Snapshot image' : `Snapshot image ${galleryPosition}`;
  switch (problem) {
    case 'CONTENT_KIND_MISSING':
      return `${image} content type is missing. Declare it as an ordinary image or a text-bearing image.`;
    case 'FULL_TEXT_MISSING':
      return `${image} is declared text-bearing but its full text is missing.`;
    case 'FULL_TEXT_TOO_LONG':
      return `${image} full text exceeds the ${ACCESSIBLE_CONTENT_LIMITS.snapshotFullText.toLocaleString('en-US')} character safety limit.`;
    case 'FULL_TEXT_UNEXPECTED':
      return `${image} is declared an ordinary image but carries a full text. Declare it text-bearing or remove the full text.`;
  }
}

/**
 * Public-feed projection of the classification for one snapshot media entry. Present only once a
 * classification exists; a legacy record published before Migration 0057 carries neither key and
 * the feed validator reports it as transitional rather than rejecting the deployed feed.
 */
export interface PublicSnapshotTextEquivalent {
  contentKind: SnapshotImageContentKind;
  /** Non-blank for `text_bearing`, null for `ordinary`. */
  fullText: string | null;
}

export function toPublicSnapshotTextEquivalent(
  input: SnapshotTextEquivalentInput,
): PublicSnapshotTextEquivalent | null {
  if (getSnapshotTextEquivalentProblem(input) !== null || !isSnapshotImageContentKind(input.contentKind)) {
    return null;
  }
  return {
    contentKind: input.contentKind,
    fullText: input.contentKind === 'text_bearing' ? (input.fullText as string).trim() : null,
  };
}
