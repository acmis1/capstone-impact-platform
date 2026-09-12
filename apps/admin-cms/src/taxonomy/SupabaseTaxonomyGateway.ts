import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type TaxonomyEntry,
  type TaxonomyGateway,
  type TaxonomyKind,
  TaxonomyConflictError,
} from './taxonomy';

type TaxonomyRow = { id: string; name: string };

const TABLE_BY_KIND: Record<TaxonomyKind, string> = {
  program: 'programs',
  discipline: 'disciplines',
  industryCategory: 'industry_categories',
};

/** Server-only gateway. The browser never receives this service-role client. */
export class SupabaseTaxonomyGateway implements TaxonomyGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(): Promise<Record<TaxonomyKind, TaxonomyEntry[]>> {
    const [programs, disciplines, industryCategories, projects, projectDisciplines, projectIndustries] = await Promise.all([
      this.supabase.from('programs').select('id, name').order('name'),
      this.supabase.from('disciplines').select('id, name').order('name'),
      this.supabase.from('industry_categories').select('id, name').order('name'),
      this.supabase.from('projects').select('program_id').not('program_id', 'is', null),
      this.supabase.from('project_disciplines').select('discipline_id'),
      this.supabase.from('project_industry_categories').select('industry_category_id'),
    ]);
    if (programs.error || disciplines.error || industryCategories.error || projects.error || projectDisciplines.error || projectIndustries.error) {
      throw new Error('Taxonomy catalogue load failed');
    }

    const countById = (rows: Array<Record<string, string | null>>, key: string) => rows.reduce((counts, row) => {
      const id = row[key];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());

    const programUsage = countById((projects.data ?? []) as Array<Record<string, string | null>>, 'program_id');
    const disciplineUsage = countById((projectDisciplines.data ?? []) as Array<Record<string, string | null>>, 'discipline_id');
    const industryUsage = countById((projectIndustries.data ?? []) as Array<Record<string, string | null>>, 'industry_category_id');
    const toEntries = (rows: TaxonomyRow[], usage: Map<string, number>): TaxonomyEntry[] =>
      rows.map((row) => ({ ...row, usageCount: usage.get(row.id) ?? 0 }));

    return {
      program: toEntries((programs.data ?? []) as TaxonomyRow[], programUsage),
      discipline: toEntries((disciplines.data ?? []) as TaxonomyRow[], disciplineUsage),
      industryCategory: toEntries((industryCategories.data ?? []) as TaxonomyRow[], industryUsage),
    };
  }

  async create(kind: TaxonomyKind, name: string): Promise<{ id: string; name: string }> {
    const { data, error } = await this.supabase
      .from(TABLE_BY_KIND[kind])
      .insert({ name })
      .select('id, name')
      .single();
    if (error) {
      if (error.code === '23505') throw new TaxonomyConflictError();
      throw new Error('Taxonomy create failed');
    }
    return data as { id: string; name: string };
  }
}
