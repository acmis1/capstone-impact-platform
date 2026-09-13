import { describe, expect, it } from 'vitest';

import { ACCESSIBLE_CONTENT_LIMITS } from './accessibleContent';
import {
  getSnapshotTextEquivalentProblem,
  parseSnapshotImageContentKind,
  toPublicSnapshotTextEquivalent,
} from './galleryTextEquivalent';

describe('gallery text-equivalent domain contract', () => {
  it('accepts an ordinary image only without a full text', () => {
    expect(getSnapshotTextEquivalentProblem({ contentKind: 'ordinary', fullText: null })).toBeNull();
    expect(toPublicSnapshotTextEquivalent({ contentKind: 'ordinary', fullText: null })).toEqual({
      contentKind: 'ordinary',
      fullText: null,
    });
    expect(getSnapshotTextEquivalentProblem({ contentKind: 'ordinary', fullText: 'Contradiction.' }))
      .toBe('FULL_TEXT_UNEXPECTED');
  });

  it('requires a nonblank bounded full text for a text-bearing image', () => {
    expect(getSnapshotTextEquivalentProblem({ contentKind: 'text_bearing', fullText: null }))
      .toBe('FULL_TEXT_MISSING');
    expect(getSnapshotTextEquivalentProblem({ contentKind: 'text_bearing', fullText: '   ' }))
      .toBe('FULL_TEXT_MISSING');
    expect(getSnapshotTextEquivalentProblem({
      contentKind: 'text_bearing',
      fullText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText),
    })).toBeNull();
    expect(getSnapshotTextEquivalentProblem({
      contentKind: 'text_bearing',
      fullText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.snapshotFullText + 1),
    })).toBe('FULL_TEXT_TOO_LONG');
  });

  it('never interprets a missing or unknown classification as ordinary', () => {
    expect(getSnapshotTextEquivalentProblem({ contentKind: null, fullText: null }))
      .toBe('CONTENT_KIND_MISSING');
    expect(getSnapshotTextEquivalentProblem({ contentKind: undefined, fullText: null }))
      .toBe('CONTENT_KIND_MISSING');
    expect(getSnapshotTextEquivalentProblem({ contentKind: 'photo' as never, fullText: null }))
      .toBe('CONTENT_KIND_MISSING');
  });

  it('parses the bounded workbook vocabulary without guessing unknown values', () => {
    expect(parseSnapshotImageContentKind(' Ordinary-image ')).toEqual({
      status: 'parsed',
      contentKind: 'ordinary',
    });
    expect(parseSnapshotImageContentKind('TEXT_BEARING')).toEqual({
      status: 'parsed',
      contentKind: 'text_bearing',
    });
    expect(parseSnapshotImageContentKind('')).toEqual({ status: 'blank' });
    expect(parseSnapshotImageContentKind('maybe a diagram')).toEqual({ status: 'unrecognized' });
  });
});
