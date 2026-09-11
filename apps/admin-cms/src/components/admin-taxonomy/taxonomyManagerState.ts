import type { TaxonomyEntry, TaxonomyKind } from '../../taxonomy/taxonomy';

export type TaxonomyNotice = { variant: 'success' | 'error'; message: string } | null;

export function addTaxonomyEntry(
  entries: TaxonomyEntry[],
  entry: Pick<TaxonomyEntry, 'id' | 'name'>,
): TaxonomyEntry[] {
  return [...entries, { ...entry, usageCount: 0 }]
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function updateTaxonomyNotice(
  current: Record<TaxonomyKind, TaxonomyNotice>,
  kind: TaxonomyKind,
  notice: TaxonomyNotice,
): Record<TaxonomyKind, TaxonomyNotice> {
  return { ...current, [kind]: notice };
}
