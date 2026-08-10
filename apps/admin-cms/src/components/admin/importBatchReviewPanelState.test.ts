import { describe, expect, it } from 'vitest';
import { pruneStaleSelection } from './importBatchReviewPanelState';

describe('pruneStaleSelection', () => {
  it('keeps selections that remain selectable', () => {
    const result = pruneStaleSelection(['a', 'b'], new Set(['a', 'b', 'c']));
    expect(result).toEqual(new Set(['a', 'b']));
  });

  it('drops a selection that is no longer ready/eligible/present', () => {
    const result = pruneStaleSelection(['a', 'b'], new Set(['a']));
    expect(result).toEqual(new Set(['a']));
  });

  it('clears the whole selection when nothing remains selectable (e.g. batch no longer completed)', () => {
    const result = pruneStaleSelection(['a', 'b'], new Set());
    expect(result).toEqual(new Set());
  });

  it('is a no-op when the selection is already empty', () => {
    const result = pruneStaleSelection([], new Set(['a']));
    expect(result).toEqual(new Set());
  });
});
