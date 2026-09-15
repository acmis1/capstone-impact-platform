import { describe, expect, it } from 'vitest';
import {
  createLayoutConfigFromStock,
  layoutRecipeNameSchema,
  resolveLayoutConfigByValue,
} from './layoutConfig';

describe('bounded layout recipe configuration', () => {
  it('creates a distinct composition from an existing preset and resolves it by value only', () => {
    const draft = createLayoutConfigFromStock('poster_showcase');
    draft.featuredMedia = 'snapshots';
    draft.sectionOrder = [
      'team', 'solution', 'background', 'links',
      'citations', 'accessibilityText', 'snapshots', 'video',
    ];
    draft.hiddenSections = ['video'];

    const resolved = resolveLayoutConfigByValue(draft);
    expect(resolved).toEqual(draft);
    expect(Object.keys(resolved).sort()).toEqual([
      'featuredMedia', 'hiddenSections', 'sectionOrder', 'templateId',
    ]);

    draft.sectionOrder[0] = 'background';
    expect(resolved.sectionOrder[0]).toBe('team');
  });

  it('rejects duplicate, unknown, incomplete, or incompatible section choices', () => {
    const valid = createLayoutConfigFromStock('technical_detail');
    expect(() => resolveLayoutConfigByValue({ ...valid, sectionOrder: [...valid.sectionOrder.slice(0, -1), 'team'] })).toThrow();
    expect(() => resolveLayoutConfigByValue({ ...valid, sectionOrder: [...valid.sectionOrder, 'unsafe-html'] })).toThrow();
    expect(() => resolveLayoutConfigByValue({ ...valid, sectionOrder: valid.sectionOrder.slice(0, -1) })).toThrow();
    expect(() => resolveLayoutConfigByValue({ ...valid, featuredMedia: 'video', hiddenSections: ['video'] })).toThrow();
  });

  it('keeps mandatory context and accessibility sections outside the hideable vocabulary', () => {
    const valid = createLayoutConfigFromStock('media_rich');
    for (const mandatory of ['team', 'accessibilityText', 'snapshots', 'metadata', 'poster']) {
      expect(() => resolveLayoutConfigByValue({ ...valid, hiddenSections: [mandatory] })).toThrow();
    }
  });

  it('normalizes bounded names while rejecting markup controls and oversized input', () => {
    expect(layoutRecipeNameSchema.parse('  Project team first  ')).toBe('Project team first');
    expect(layoutRecipeNameSchema.safeParse('Unsafe\u0000name').success).toBe(false);
    expect(layoutRecipeNameSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });
});
