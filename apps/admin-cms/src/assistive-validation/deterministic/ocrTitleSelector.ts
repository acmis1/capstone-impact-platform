import type { Phase1BoundingBox, Phase1ExtractionResult, Phase1TextBlock } from '../domain/extractionContract';
import { normalizeTitle } from './normalization';
import type { TitleCandidate } from './titleCandidates';

/** Frozen Issue #214 metadata-blind full-page selector. */
export const OCR_TITLE_SELECTOR_ID = 'top-band-typography-consistent-group-prominence-v4@geometry';

const TOP_BAND_RATIO = 0.34;
const GROUP_BONUS = 0.12;
const MAX_GROUP_LINES = 3;
const MAX_CANDIDATES = 8;
const MAX_CANDIDATE_CHARACTERS = 400;
const HEIGHT_TOLERANCE = 0.3;
const GAP_LINE_HEIGHTS = 1;
const ROW_OVERLAP_RATIO = 0.5;
const EXTENT_ASCENDER_AND_DESCENDER = 0.98;
const EXTENT_ASCENDER_ONLY = 0.75;
const EXTENT_DESCENDER_ONLY = 0.78;
const EXTENT_X_HEIGHT_ONLY = 0.55;
const DESCENDER_CHARACTERS = new Set([...'gjpqy,;']);
const ASCENDER_CHARACTERS = new Set([...'bdfhklt']);

interface LocatedLine {
  index: number;
  text: string;
  box: Phase1BoundingBox;
}

interface LineGroup {
  text: string;
  box: Phase1BoundingBox;
  lineCount: number;
  firstIndex: number;
  blockIndexes: readonly number[];
  meanTypeSize: number;
}

/** Frozen equality normalization, including hyphen and slash folding. */
export function normalizeFrozenTitle(value: string): string {
  return normalizeTitle(value).replace(/[-/\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Letter-case style of a rendered line: a typographic property, never its meaning. */
export function caseStyle(text: string): 'UPPER' | 'MIXED' | 'NEUTRAL' {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) return 'NEUTRAL';
  return letters.every((character) => character === character.toLocaleUpperCase('en-US')
    && character !== character.toLocaleLowerCase('en-US')) ? 'UPPER' : 'MIXED';
}

/** Fraction of type size that this line's own character classes can paint. */
export function verticalExtentRatio(text: string): number {
  const characters = [...text];
  const tall = characters.some((character) => /\p{Lu}|\p{Nd}/u.test(character)
    || ASCENDER_CHARACTERS.has(character));
  const deep = characters.some((character) => DESCENDER_CHARACTERS.has(character));
  if (tall && deep) return EXTENT_ASCENDER_AND_DESCENDER;
  if (tall) return EXTENT_ASCENDER_ONLY;
  if (deep) return EXTENT_DESCENDER_ONLY;
  return EXTENT_X_HEIGHT_ONLY;
}

function boxHeight(box: Phase1BoundingBox): number {
  return Math.max(1, box.bottom - box.top);
}

export function typeSize(box: Phase1BoundingBox, text: string): number {
  return boxHeight(box) / verticalExtentRatio(text);
}

function locatedLines(blocks: readonly Phase1TextBlock[]): LocatedLine[] {
  const lines: LocatedLine[] = [];
  blocks.forEach((block, index) => {
    const text = block.text.replace(/\s+/g, ' ').trim();
    if (!text || block.bounding_box === null) return;
    lines.push({ index, text, box: block.bounding_box });
  });
  return lines;
}

/** Frozen geometry order: top-to-bottom rows, then left-to-right within each row. */
function geometryOrder(lines: readonly LocatedLine[]): LocatedLine[] {
  const ordered = [...lines].sort((left, right) => left.box.top - right.box.top
    || left.box.left - right.box.left || left.index - right.index);
  const rows: LocatedLine[][] = [];
  let span: { top: number; bottom: number } | null = null;
  for (const line of ordered) {
    if (span === null) {
      rows.push([line]);
      span = { top: line.box.top, bottom: line.box.bottom };
      continue;
    }
    const overlap = Math.min(span.bottom, line.box.bottom) - Math.max(span.top, line.box.top);
    const reference = Math.min(boxHeight(line.box), Math.max(1, span.bottom - span.top));
    if (overlap >= ROW_OVERLAP_RATIO * reference) {
      rows[rows.length - 1].push(line);
      span = { top: Math.min(span.top, line.box.top), bottom: Math.max(span.bottom, line.box.bottom) };
    } else {
      rows.push([line]);
      span = { top: line.box.top, bottom: line.box.bottom };
    }
  }
  return rows.flatMap((row) => [...row].sort((left, right) => left.box.left - right.box.left
    || left.box.top - right.box.top || left.index - right.index));
}

export function typographyConsistent(previous: LocatedLine, following: LocatedLine): boolean {
  if (following.box.top < previous.box.top) return false;
  const previousSize = typeSize(previous.box, previous.text);
  const followingSize = typeSize(following.box, following.text);
  if (Math.min(previousSize, followingSize) / Math.max(previousSize, followingSize) < 1 - HEIGHT_TOLERANCE) return false;
  if (following.box.top - previous.box.bottom > GAP_LINE_HEIGHTS
    * Math.min(boxHeight(previous.box), boxHeight(following.box))) return false;
  const previousStyle = caseStyle(previous.text);
  const followingStyle = caseStyle(following.text);
  return previousStyle === 'NEUTRAL' || followingStyle === 'NEUTRAL' || previousStyle === followingStyle;
}

function typographyConsistentGroups(ordered: readonly LocatedLine[]): LineGroup[] {
  const groups: LineGroup[] = [];
  for (let start = 0; start < ordered.length; start += 1) {
    const members: LocatedLine[] = [];
    for (let offset = 0; offset < MAX_GROUP_LINES && start + offset < ordered.length; offset += 1) {
      const line = ordered[start + offset];
      if (offset > 0 && !typographyConsistent(members[members.length - 1], line)) break;
      members.push(line);
      const text = members.map((item) => item.text).join(' ');
      if (text.length > MAX_CANDIDATE_CHARACTERS) break;
      groups.push({
        text,
        box: {
          left: Math.min(...members.map((item) => item.box.left)),
          top: Math.min(...members.map((item) => item.box.top)),
          right: Math.max(...members.map((item) => item.box.right)),
          bottom: Math.max(...members.map((item) => item.box.bottom)),
          unit: members[0].box.unit,
        },
        lineCount: members.length,
        firstIndex: start,
        blockIndexes: members.map((item) => item.index),
        meanTypeSize: members.reduce((total, item) => total + typeSize(item.box, item.text), 0)
          / members.length,
      });
    }
  }
  return groups;
}

/** Rank page-one OCR line groups using geometry and typography only. */
export function selectOcrTitleCandidates(extraction: Phase1ExtractionResult): TitleCandidate[] {
  if (extraction.status !== 'COMPLETED' || extraction.source !== 'OCR') return [];
  const lines = locatedLines(extraction.blocks.filter((block) => block.page_number === 1));
  if (lines.length === 0) return [];
  const ordered = geometryOrder(lines);
  const top = Math.min(...ordered.map((line) => line.box.top));
  const bottom = Math.max(...ordered.map((line) => line.box.bottom));
  const limit = top + TOP_BAND_RATIO * Math.max(1, bottom - top);
  const banded = typographyConsistentGroups(ordered).filter((group) => group.box.top <= limit);
  banded.sort((left, right) => {
    const leftProminence = Number((left.meanTypeSize * (1 + GROUP_BONUS * (left.lineCount - 1))).toFixed(3));
    const rightProminence = Number((right.meanTypeSize * (1 + GROUP_BONUS * (right.lineCount - 1))).toFixed(3));
    return rightProminence - leftProminence
      || right.lineCount - left.lineCount
      || left.box.top - right.box.top
      || left.firstIndex - right.firstIndex;
  });
  const candidates: TitleCandidate[] = [];
  const seen = new Set<string>();
  for (const group of banded) {
    const normalized = normalizeMetricTitle(group.text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({
      text: group.text,
      pageNumber: 1,
      boundingBox: group.box,
      blockIndexes: group.blockIndexes,
      prominence: Number((group.meanTypeSize * (1 + GROUP_BONUS * (group.lineCount - 1))).toFixed(3)),
      rank: candidates.length + 1,
    });
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return candidates;
}

function normalizeMetricTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}
