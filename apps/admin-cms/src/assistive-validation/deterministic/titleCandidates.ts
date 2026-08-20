import type { Phase1BoundingBox, Phase1ExtractionResult } from '../domain/extractionContract';
import { normalizeTitle } from './normalization';

export const MAX_TITLE_CANDIDATES = 8;

export interface TitleCandidate {
  text: string;
  pageNumber: number;
  boundingBox: Phase1BoundingBox | null;
  blockIndexes: readonly number[];
  /** Relative document-evidence prominence, not an OCR confidence. */
  prominence: number;
  rank: number;
}

interface CandidateDraft extends Omit<TitleCandidate, 'rank' | 'prominence'> {
  geometryScore: number;
  firstIndex: number;
}

function cleanedLine(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length < 3 || text.length > 160 || /[\u0000-\u001F\u007F\uFFFD]/.test(text)) return null;
  return text;
}

function canJoin(previous: Phase1BoundingBox | null, next: Phase1BoundingBox | null): boolean {
  if (previous === null || next === null) return true;
  if (previous.unit !== next.unit || next.top < previous.top) return false;
  const previousHeight = Math.max(1, previous.bottom - previous.top);
  const nextHeight = Math.max(1, next.bottom - next.top);
  return next.top - previous.bottom <= 2 * Math.min(previousHeight, nextHeight);
}

function combinedBox(boxes: Array<Phase1BoundingBox | null>): Phase1BoundingBox | null {
  if (boxes.some((box) => box === null)) return null;
  const present = boxes as Phase1BoundingBox[];
  if (present.some((box) => box.unit !== present[0].unit)) return null;
  return {
    left: Math.min(...present.map((box) => box.left)),
    top: Math.min(...present.map((box) => box.top)),
    right: Math.max(...present.map((box) => box.right)),
    bottom: Math.max(...present.map((box) => box.bottom)),
    unit: present[0].unit,
  };
}

function geometryScore(box: Phase1BoundingBox | null): number {
  if (box === null) return 0;
  const height = Math.max(0, box.bottom - box.top);
  return Math.min(10_000, height * 3) - Math.min(100, box.top / Math.max(1, height));
}

/**
 * Ranks document-derived candidates only. Metadata is intentionally absent from this API.
 * Page order, real top-left geometry, prominence, adjacent line grouping, and bounded text
 * are the only evidence used.
 */
export function extractTitleCandidates(extraction: Phase1ExtractionResult): TitleCandidate[] {
  if (extraction.status !== 'COMPLETED') return [];
  const blocks = extraction.blocks.map((block, index) => ({ ...block, index, cleaned: cleanedLine(block.text) }));
  const drafts: CandidateDraft[] = [];
  for (const block of blocks) {
    if (block.cleaned === null) continue;
    for (let length = 1; length <= 3; length += 1) {
      const group = blocks.slice(block.index, block.index + length);
      if (group.length !== length || group.some((item) => item.cleaned === null || item.page_number !== block.page_number)) break;
      if (length > 1 && !canJoin(group[length - 2].bounding_box, group[length - 1].bounding_box)) break;
      const text = group.map((item) => item.cleaned as string).join(' ');
      if (text.length > 400) break;
      const box = combinedBox(group.map((item) => item.bounding_box));
      drafts.push({
        text,
        pageNumber: block.page_number,
        boundingBox: box,
        blockIndexes: group.map((item) => item.index),
        firstIndex: block.index,
        geometryScore: geometryScore(box) + (length - 1) * 2,
      });
    }
  }
  const seen = new Set<string>();
  return drafts
    .sort((left, right) => left.pageNumber - right.pageNumber || right.geometryScore - left.geometryScore || left.firstIndex - right.firstIndex)
    .filter((draft) => {
      const key = `${draft.pageNumber}:${normalizeTitle(draft.text)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_TITLE_CANDIDATES)
    .map((draft, index) => ({
      text: draft.text,
      pageNumber: draft.pageNumber,
      boundingBox: draft.boundingBox,
      blockIndexes: draft.blockIndexes,
      prominence: Number(draft.geometryScore.toFixed(3)),
      rank: index + 1,
    }));
}
