import { SupabaseClient } from '@supabase/supabase-js';

export interface BulkReviewReferenceIds {
  programIds: string[];
  disciplineIds: string[];
  industryIds: string[];
}

export interface BulkReviewReferenceOwnership {
  programIds: string[];
  disciplineIds: string[];
  industryIds: string[];
}

export interface BulkReviewReferenceFixtures extends BulkReviewReferenceIds {
  ownership: BulkReviewReferenceOwnership;
}

export interface BulkReviewReferenceFixtureResidue {
  programs: number;
  disciplines: number;
  industryCategories: number;
}

type ReferenceTable = 'programs' | 'disciplines' | 'industry_categories';

function requireData<T>(data: T | null, error: unknown, message: string): T {
  if (error || data === null) throw new Error(message);
  return data;
}

function rowsToIds(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

async function insertOwnedReference(
  supabase: SupabaseClient,
  table: ReferenceTable,
  name: string,
): Promise<string> {
  const result = await supabase.from(table).insert({ name }).select('id').single();
  const row = requireData(result.data, result.error, `Could not create verifier-owned ${table} reference.`) as { id: string };
  return row.id;
}

async function deleteOwnedReferences(
  supabase: SupabaseClient,
  table: ReferenceTable,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const deletion = await supabase.from(table).delete().in('id', ids);
  if (deletion.error) throw new Error(`Could not delete verifier-owned ${table} references.`);

  const residue = await supabase.from(table).select('id', { count: 'exact', head: true }).in('id', ids);
  if (residue.error) throw new Error(`Could not verify cleanup of verifier-owned ${table} references.`);
  return residue.count ?? 0;
}

/**
 * Acquires the taxonomy IDs needed by the bulk-review verifiers without depending on seed data.
 * Existing rows are never modified or tracked for cleanup; only IDs returned from this helper's
 * own inserts are deleted by `cleanupBulkReviewReferenceFixtures`.
 */
export async function acquireBulkReviewReferenceFixtures(
  supabase: SupabaseClient,
  fixtureIdentity: string,
): Promise<BulkReviewReferenceFixtures> {
  const ownership: BulkReviewReferenceOwnership = { programIds: [], disciplineIds: [], industryIds: [] };
  try {
    const [programs, disciplines, industries] = await Promise.all([
      supabase.from('programs').select('id').limit(5),
      supabase.from('disciplines').select('id').limit(5),
      supabase.from('industry_categories').select('id').limit(5),
    ]);
    const programIds = rowsToIds(requireData(programs.data, programs.error, 'Program references are unavailable.') as Array<{ id: string }>);
    const disciplineIds = rowsToIds(requireData(disciplines.data, disciplines.error, 'Discipline references are unavailable.') as Array<{ id: string }>);
    const industryIds = rowsToIds(requireData(industries.data, industries.error, 'Industry category references are unavailable.') as Array<{ id: string }>);

    if (programIds.length === 0) {
      const id = await insertOwnedReference(supabase, 'programs', `${fixtureIdentity}-program`);
      programIds.push(id);
      ownership.programIds.push(id);
    }
    if (disciplineIds.length === 0) {
      const id = await insertOwnedReference(supabase, 'disciplines', `${fixtureIdentity}-discipline`);
      disciplineIds.push(id);
      ownership.disciplineIds.push(id);
    }
    if (industryIds.length === 0) {
      const id = await insertOwnedReference(supabase, 'industry_categories', `${fixtureIdentity}-industry`);
      industryIds.push(id);
      ownership.industryIds.push(id);
    }

    return { programIds, disciplineIds, industryIds, ownership };
  } catch (error) {
    await cleanupBulkReviewReferenceFixtures(supabase, ownership);
    throw error;
  }
}

export async function cleanupBulkReviewReferenceFixtures(
  supabase: SupabaseClient,
  ownership: BulkReviewReferenceOwnership,
): Promise<BulkReviewReferenceFixtureResidue> {
  const [programs, disciplines, industryCategories] = await Promise.all([
    deleteOwnedReferences(supabase, 'programs', ownership.programIds),
    deleteOwnedReferences(supabase, 'disciplines', ownership.disciplineIds),
    deleteOwnedReferences(supabase, 'industry_categories', ownership.industryIds),
  ]);
  return { programs, disciplines, industryCategories };
}

export function referenceFixtureCleanupIsClean(residue: BulkReviewReferenceFixtureResidue): boolean {
  return residue.programs === 0 && residue.disciplines === 0 && residue.industryCategories === 0;
}
