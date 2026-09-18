import { FEATURED_MEDIA_PRESENTATION, LAYOUT_SECTION_PRESENTATION, LAYOUT_TEMPLATE_PRESENTATION } from './layoutPresentation';

function namedValue<T extends Record<string, unknown>>(map: T, key: unknown): T[keyof T] | undefined {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key as keyof T] : undefined;
}

export function layoutTemplateLabel(value: unknown): string {
  return namedValue(LAYOUT_TEMPLATE_PRESENTATION, value)?.label ?? 'Not recorded';
}

export function featuredMediaLabel(value: unknown): string {
  return namedValue(FEATURED_MEDIA_PRESENTATION, value) ?? 'Renderer default';
}

const LEGACY_SECTION_LABELS: Record<string, string> = {
  summary: 'Short public summary', poster: 'Poster image', posterPdf: 'Poster PDF',
  metadata: 'Project information', externalLinks: 'Project resources',
};

export function layoutSectionLabel(value: string): string {
  return namedValue(LAYOUT_SECTION_PRESENTATION, value)?.label
    ?? namedValue(LEGACY_SECTION_LABELS, value) ?? 'Unsupported section';
}

export function layoutSectionList(values: readonly string[] | undefined, emptyLabel = 'None'): string {
  return values?.length ? values.map(layoutSectionLabel).join(', ') : emptyLabel;
}
