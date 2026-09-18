import 'server-only';
import { z } from 'zod';
import { postgresUuidSchema } from '../projects/projectMetadata';
import { readCatalogueRows } from './catalogueRows';
import { withCatalogueUsage } from './catalogueUsage';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type TaxonomyEntry,
  type TaxonomyGateway,
  type TaxonomyKind,
  TaxonomyConflictError,
} from './taxonomy';


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
      ...['programs', 'disciplines', 'industry_categories'].map(table => readCatalogueRows(this.supabase, table, 'id,name,retired_at,lifecycle_version', ['id'])),
      readCatalogueRows(this.supabase, 'projects', 'id,program_id,program_name,study_program,discipline,industry', ['id']),
      readCatalogueRows(this.supabase, 'project_disciplines', 'project_id,discipline_id', ['project_id', 'discipline_id']),
      readCatalogueRows(this.supabase, 'project_industry_categories', 'project_id,industry_category_id', ['project_id', 'industry_category_id']),
    ]);
    const schema = z.array(z.object({ id: postgresUuidSchema, name: z.string().min(1).max(120), retired_at: z.string().datetime({ offset: true }).nullable(), lifecycle_version: z.number().int().min(1) }).strict());
    const entries = (rows: unknown): TaxonomyEntry[] => {
      const parsed = schema.safeParse(rows);
      if (!parsed.success) throw new Error('Catalogue lifecycle data unavailable.');
      return parsed.data.map(row => ({ id: row.id, name: row.name, retiredAt: row.retired_at, lifecycleVersion: row.lifecycle_version, usageCount: 0 }));
    };
    return withCatalogueUsage({ program: entries(programs), discipline: entries(disciplines), industryCategory: entries(industryCategories) }, projects, projectDisciplines, projectIndustries);
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

  async lifecycle(input: {
    kind: TaxonomyKind;
    taxonomyId: string;
    action: 'retire' | 'reactivate' | 'rename';
    name?: string;
    expectedLifecycleVersion: number;
    actorAdminId: string;
  }) {
    const { data, error } = await this.supabase.rpc('manage_taxonomy_lifecycle', {
      p_kind: input.kind,
      p_taxonomy_id: input.taxonomyId,
      p_action: input.action,
      p_name: input.name ?? null,
      p_expected_lifecycle_version: input.expectedLifecycleVersion,
      p_actor_admin_id: input.actorAdminId,
    });
    if (error || typeof data !== 'object' || data === null || !('resultCode' in data) || typeof data.resultCode !== 'string') {
      throw new Error('Taxonomy lifecycle failed');
    }
    return data as { resultCode: string; id?: string; name?: string; retiredAt?: string | null; lifecycleVersion?: number; referenceCount?: number };
  }
}
