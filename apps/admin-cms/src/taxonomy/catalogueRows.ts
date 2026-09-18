import type { SupabaseClient } from '@supabase/supabase-js';

/** Complete bounded reads; a provider row cap must never look like the end of a catalogue. */
export async function readCatalogueRows(client: SupabaseClient, table: string, columns: string, identity: readonly string[]): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 1000; page += 1) {
    let query = client.from(table).select(columns);
    for (const key of identity) query = query.order(key, { ascending: true });
    const result = await query.range(rows.length, rows.length + 499);
    if (result.error || !Array.isArray(result.data)) throw new Error('Catalogue records unavailable.');
    if (result.data.length === 0) return rows;
    if (result.data.length > 500 || rows.length + result.data.length > 50_000) throw new Error('Catalogue read limit exceeded.');
    for (const value of result.data as unknown[]) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Catalogue row invalid.');
      const row = value as Record<string, unknown>;
      const parts = identity.map(key => row[key]);
      if (parts.some(value => typeof value !== 'string' || !value)) throw new Error('Catalogue identity unavailable.');
      const key = JSON.stringify(parts);
      if (seen.has(key)) throw new Error('Catalogue changed during paging.');
      seen.add(key); rows.push(row);
    }
  }
  throw new Error('Catalogue paging did not terminate safely.');
}
