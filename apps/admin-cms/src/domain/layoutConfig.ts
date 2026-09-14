import { z } from 'zod';
import type { LayoutConfig } from './project';

export const LAYOUT_TEMPLATE_IDS = [
  'poster_showcase',
  'technical_detail',
  'media_rich',
] as const;

export const LAYOUT_FEATURED_MEDIA = [
  'auto',
  'poster',
  'snapshots',
  'video',
  'none',
] as const;

/**
 * Existing section primitives understood by the maintained Duda renderer. A recipe may only
 * reorder these values; it cannot introduce executable markup, styling, or renderer plugins.
 */
export const LAYOUT_SECTION_IDS = [
  'background',
  'solution',
  'snapshots',
  'video',
  'team',
  'links',
  'citations',
  'accessibilityText',
] as const;

/** Optional sections only. Team/context and accessibility equivalents remain visible. */
export const HIDEABLE_LAYOUT_SECTION_IDS = [
  'background',
  'solution',
  'video',
  'links',
  'citations',
] as const;

/** Historical renderer vocabulary retained for old feed/config compatibility. */
export const LEGACY_RENDERER_SECTION_IDS = [
  ...LAYOUT_SECTION_IDS,
  'externalLinks',
  'summary',
  'poster',
  'posterPdf',
  'metadata',
] as const;

export type LayoutTemplateId = typeof LAYOUT_TEMPLATE_IDS[number];
export type LayoutFeaturedMedia = typeof LAYOUT_FEATURED_MEDIA[number];
export type LayoutSectionId = typeof LAYOUT_SECTION_IDS[number];
export type HideableLayoutSectionId = typeof HIDEABLE_LAYOUT_SECTION_IDS[number];

export interface ResolvedLayoutConfig extends LayoutConfig {
  templateId: LayoutTemplateId;
  featuredMedia: LayoutFeaturedMedia;
  sectionOrder: LayoutSectionId[];
  hiddenSections: HideableLayoutSectionId[];
}

const layoutTemplateSchema = z.enum(LAYOUT_TEMPLATE_IDS);
const featuredMediaSchema = z.enum(LAYOUT_FEATURED_MEDIA);
const layoutSectionSchema = z.enum(LAYOUT_SECTION_IDS);
const hideableSectionSchema = z.enum(HIDEABLE_LAYOUT_SECTION_IDS);

export const layoutRecipeNameSchema = z.string()
  .trim()
  .min(1, 'Enter a recipe name.')
  .max(120, 'Recipe names must be 120 characters or fewer.')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Recipe names cannot contain control characters.');

export const resolvedLayoutConfigSchema = z.object({
  templateId: layoutTemplateSchema,
  featuredMedia: featuredMediaSchema,
  sectionOrder: z.array(layoutSectionSchema).length(LAYOUT_SECTION_IDS.length),
  hiddenSections: z.array(hideableSectionSchema).max(HIDEABLE_LAYOUT_SECTION_IDS.length).default([]),
}).strict().superRefine((config, context) => {
  if (new Set(config.sectionOrder).size !== config.sectionOrder.length) {
    context.addIssue({ code: 'custom', path: ['sectionOrder'], message: 'Each layout section must appear exactly once.' });
  }
  if (new Set(config.hiddenSections).size !== config.hiddenSections.length) {
    context.addIssue({ code: 'custom', path: ['hiddenSections'], message: 'Hidden sections cannot contain duplicates.' });
  }

  const expectedSections = new Set<string>(LAYOUT_SECTION_IDS);
  if (config.sectionOrder.some((section) => !expectedSections.delete(section)) || expectedSections.size > 0) {
    context.addIssue({ code: 'custom', path: ['sectionOrder'], message: 'Section order must contain every supported section exactly once.' });
  }

  if (config.featuredMedia === 'video' && config.hiddenSections.includes('video')) {
    context.addIssue({ code: 'custom', path: ['featuredMedia'], message: 'Featured video cannot also be hidden.' });
  }
});

const BASE_SECTION_ORDER: LayoutSectionId[] = [...LAYOUT_SECTION_IDS];

/** Composer starting points for the three existing renderer presets; these are not new presets. */
export const STOCK_LAYOUT_CONFIGS: Record<LayoutTemplateId, ResolvedLayoutConfig> = {
  poster_showcase: {
    templateId: 'poster_showcase',
    featuredMedia: 'poster',
    sectionOrder: [...BASE_SECTION_ORDER],
    hiddenSections: [],
  },
  technical_detail: {
    templateId: 'technical_detail',
    featuredMedia: 'snapshots',
    sectionOrder: ['solution', 'background', 'snapshots', 'video', 'team', 'links', 'citations', 'accessibilityText'],
    hiddenSections: [],
  },
  media_rich: {
    templateId: 'media_rich',
    featuredMedia: 'video',
    sectionOrder: ['snapshots', 'video', 'solution', 'background', 'team', 'links', 'citations', 'accessibilityText'],
    hiddenSections: [],
  },
};

export function createLayoutConfigFromStock(templateId: LayoutTemplateId): ResolvedLayoutConfig {
  const stock = STOCK_LAYOUT_CONFIGS[templateId];
  return {
    ...stock,
    sectionOrder: [...stock.sectionOrder],
    hiddenSections: [...stock.hiddenSections],
  };
}

/**
 * The value-copy boundary: recipe administration metadata is deliberately discarded here.
 * Projects, participant snapshots, and public feeds receive only the existing LayoutConfig wire.
 */
export function resolveLayoutConfigByValue(input: unknown): ResolvedLayoutConfig {
  const parsed = resolvedLayoutConfigSchema.parse(input);
  return {
    templateId: parsed.templateId,
    featuredMedia: parsed.featuredMedia,
    sectionOrder: [...parsed.sectionOrder],
    hiddenSections: [...parsed.hiddenSections],
  };
}

/**
 * Compatibility validator for existing project/feed wires. Older records may omit optional hints
 * or use renderer-supported legacy sections; unknown/duplicate/unbounded values are still rejected.
 */
export function getLayoutConfigWireProblems(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['must be an object'];
  const config = input as Record<string, unknown>;
  const problems: string[] = [];
  const allowedKeys = new Set(['templateId', 'featuredMedia', 'sectionOrder', 'hiddenSections']);
  if (Object.keys(config).some((key) => !allowedKeys.has(key))) problems.push('contains unsupported fields');
  if (!LAYOUT_TEMPLATE_IDS.includes(config.templateId as LayoutTemplateId)) problems.push('has an unknown templateId');
  if (config.featuredMedia !== undefined && !LAYOUT_FEATURED_MEDIA.includes(config.featuredMedia as LayoutFeaturedMedia)) {
    problems.push('has an unknown featuredMedia');
  }

  const validateList = (key: 'sectionOrder' | 'hiddenSections') => {
    const value = config[key];
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > LEGACY_RENDERER_SECTION_IDS.length) {
      problems.push(`${key} must be a bounded array`);
      return;
    }
    if (value.some((section) => typeof section !== 'string' || !LEGACY_RENDERER_SECTION_IDS.includes(section as never))) {
      problems.push(`${key} contains an unknown section`);
    }
    if (new Set(value).size !== value.length) problems.push(`${key} contains duplicate sections`);
  };
  validateList('sectionOrder');
  validateList('hiddenSections');

  if (Array.isArray(config.hiddenSections)) {
    if (config.featuredMedia === 'video' && config.hiddenSections.includes('video')) problems.push('featured video is hidden');
    if (config.featuredMedia === 'snapshots' && config.hiddenSections.includes('snapshots')) problems.push('featured snapshots are hidden');
  }
  return problems;
}
