import type { TaxonomyEntry, TaxonomyKind } from './taxonomy';

type Row = Record<string, unknown>;
export function withCatalogueUsage(catalogues: Record<TaxonomyKind, TaxonomyEntry[]>, projects: Row[], disciplineRefs: Row[], industryRefs: Row[]): Record<TaxonomyKind, TaxonomyEntry[]> {
  const usage = new Map<string, Set<string>>();
  const add = (kind: TaxonomyKind, categoryId: unknown, projectId: unknown) => {
    if (typeof categoryId !== 'string' || typeof projectId !== 'string') return;
    const key = `${kind}:${categoryId}`; const entries = usage.get(key) ?? new Set<string>();
    entries.add(projectId); usage.set(key, entries);
  };
  const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
  for (const project of projects) {
    add('program', project.program_id, project.id);
    for (const kind of ['program', 'discipline', 'industryCategory'] as const) {
      const names = kind === 'program' ? [project.program_name, project.study_program] : [project[kind === 'discipline' ? 'discipline' : 'industry']];
      const normalized = names.map(normalize).filter(Boolean);
      for (const entry of catalogues[kind]) if (normalized.includes(normalize(entry.name))) add(kind, entry.id, project.id);
    }
  }
  for (const row of disciplineRefs) add('discipline', row.discipline_id, row.project_id);
  for (const row of industryRefs) add('industryCategory', row.industry_category_id, row.project_id);
  return Object.fromEntries(Object.entries(catalogues).map(([kind, entries]) => [kind, entries.map(entry => ({
    ...entry, usageCount: usage.get(`${kind}:${entry.id}`)?.size ?? 0,
  }))])) as Record<TaxonomyKind, TaxonomyEntry[]>;
}
