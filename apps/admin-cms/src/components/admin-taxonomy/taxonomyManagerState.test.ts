import { describe, expect, it } from 'vitest';
import { addTaxonomyEntry, removeTaxonomyEntryFromState, updateTaxonomyNotice } from './taxonomyManagerState';

describe('taxonomy manager state', () => {
  it('inserts a newly-created option in display order with zero project references', () => {
    expect(addTaxonomyEntry([{ id: 'b', name: 'IT', usageCount: 2 }], { id: 'a', name: 'Aviation' })).toEqual([
      { id: 'a', name: 'Aviation', usageCount: 0 },
      { id: 'b', name: 'IT', usageCount: 2 },
    ]);
  });

  it('removes only the successfully deleted unused catalogue entry', () => {
    expect(removeTaxonomyEntryFromState([
      { id: 'a', name: 'Aviation', usageCount: 0 },
      { id: 'b', name: 'Engineering', usageCount: 3 },
    ], 'a')).toEqual([{ id: 'b', name: 'Engineering', usageCount: 3 }]);
  });

  it('keeps status feedback scoped to the taxonomy section that changed', () => {
    const state = { program: null, discipline: null, industryCategory: null };
    expect(updateTaxonomyNotice(state, 'program', { variant: 'success', message: 'Program added.' })).toEqual({
      program: { variant: 'success', message: 'Program added.' },
      discipline: null,
      industryCategory: null,
    });
  });
});
