import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPublicFeedHistory } from './publicFeedHistoryRepository';

type Row = Record<string, unknown>;

function createSupabaseStub(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        is: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          const direction = options?.ascending === false ? -1 : 1;
          rows.sort((left, right) => (Number(left[column]) - Number(right[column])) * direction);
          return query;
        },
        limit: (count: number) => {
          rows = rows.slice(0, count);
          return query;
        },
        range: (from: number, to: number) => {
          rows = rows.slice(from, to + 1);
          return query;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

function historyStub(blockingOperation?: Row): SupabaseClient {
  const versions = Array.from({ length: 125 }, (_, index) => {
    const versionNumber = index + 1;
    return {
      id: `v${versionNumber}`, version_number: versionNumber,
      operation: versionNumber === 105 ? 'rollback' : versionNumber === 1 ? 'baseline' : 'publication',
      publication_mode: versionNumber === 105 || versionNumber === 1 ? null : 'normal',
      previous_version_id: versionNumber === 1 ? null : `v${versionNumber - 1}`,
      restored_from_version_id: versionNumber === 105 ? 'v1' : null,
      affected_public_id: versionNumber === 1 || versionNumber === 105 ? null : 'synthetic-project',
      authorizing_actor_id: 'admin', completion_actor_id: 'admin',
      byte_count: versionNumber, feed_hash: versionNumber.toString(16).padStart(64, '0'),
      record_count: 1, created_at: `2026-08-25T00:${String(versionNumber % 60).padStart(2, '0')}:00.000Z`,
    };
  });
  return createSupabaseStub({
    public_feed_head: [{ singleton: true, current_version_id: 'v125', generation: 125, rollback_enabled: true }],
    public_feed_versions: versions,
    public_feed_version_members: versions.map((version) => ({
      version_id: version.id, ordinal: 0, public_id: 'synthetic-project',
    })),
    projects: [{ public_id: 'synthetic-project', title: 'Synthetic project', status: 'published', deleted_at: null }],
    public_feed_operations: blockingOperation ? [blockingOperation] : [],
    admin_users: [{ id: 'admin', full_name: 'Synthetic Admin', email: 'admin@example.invalid' }],
  });
}

describe('public feed history pagination', () => {
  it('returns bounded pages with no duplicate or missing boundary version', async () => {
    const first = await readPublicFeedHistory(historyStub(), undefined, 1);
    const second = await readPublicFeedHistory(historyStub(), undefined, 2);
    const third = await readPublicFeedHistory(historyStub(), undefined, 3);

    expect(first.versions).toHaveLength(50);
    expect(first.versions[0].versionNumber).toBe(125);
    expect(first.versions.at(-1)?.versionNumber).toBe(76);
    expect(first.hasNewer).toBe(false);
    expect(first.hasOlder).toBe(true);
    expect(second.versions.map((version) => version.versionNumber)).toEqual(
      Array.from({ length: 50 }, (_, index) => 75 - index),
    );
    expect(second.hasNewer).toBe(true);
    expect(second.hasOlder).toBe(true);
    expect(third.versions.map((version) => version.versionNumber)).toEqual(
      Array.from({ length: 25 }, (_, index) => 25 - index),
    );
    expect(third.hasNewer).toBe(true);
    expect(third.hasOlder).toBe(false);
  });

  it('resolves detail and members for a selected version older than the first 100 rows', async () => {
    const view = await readPublicFeedHistory(historyStub(), 1, 1);

    expect(view.versions.some((version) => version.versionNumber === 1)).toBe(false);
    expect(view.detail).toMatchObject({
      versionNumber: 1,
      previousVersionNumber: null,
      members: [{ publicId: 'synthetic-project', title: 'Synthetic project' }],
    });
    expect(view.currentVersionNumber).toBe(125);
  });

  it('keeps previous and restored references truthful across page boundaries', async () => {
    const view = await readPublicFeedHistory(historyStub(), 105, 1);

    expect(view.detail).toMatchObject({
      versionNumber: 105,
      previousVersionNumber: 104,
      restoredFromVersionNumber: 1,
    });
  });

  it('projects durable lease and Storage fence timestamps for presentation decisions', async () => {
    const view = await readPublicFeedHistory(historyStub({
      kind: 'publication', state: 'WRITE_STARTED', failure_code: null,
      updated_at: '2026-08-27T11:58:00.000Z',
      lease_expires_at: '2026-08-27T12:00:00.000Z',
      storage_uncertainty_until: '2026-08-27T12:01:00.000Z',
    }));

    expect(view.blockingOperation).toEqual({
      kind: 'publication', state: 'WRITE_STARTED', failureCode: null,
      updatedAt: '2026-08-27T11:58:00.000Z',
      leaseExpiresAt: '2026-08-27T12:00:00.000Z',
      storageUncertaintyUntil: '2026-08-27T12:01:00.000Z',
    });
  });
});
